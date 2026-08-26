/**
 * Socket-budget tests: Eddie in a real Chrome, driven over CDP.
 *
 * The bug these guard against (2026-08-26): every open canvas tab held its
 * event-stream socket open for the life of the tab. A browser shares ~6
 * sockets per origin across all of its tabs, so six canvases left open — the
 * normal way a dashboard lives here — starved the origin: the next canvas
 * queued behind them and never loaded at all, its renderer wedged so hard it
 * stopped answering the debugger. Safari has its own pool, so pasting the same
 * URL there always worked, which hid the cause through four rounds of
 * white-screen patches on the canvas side.
 *
 * Two mechanisms keep it dead, and both are gated here:
 *   parking  — a hidden canvas hands its stream back and reconnects on return
 *   ration   — at most MAX_STREAMS live streams; the canvas looked at longest
 *              ago yields its feed, says so, and takes it back on a click
 *
 * Gates:
 *   A  a fresh canvas always loads, however many canvases are already open
 *   B  a hidden canvas holds no event-stream socket, and reclaims it on return
 *   C  returning to a parked canvas reloads the artifact only if it changed
 *   D  live streams never exceed the ration, and a yielded canvas says so
 *
 * No browser automation dependency: Chrome is driven over the DevTools
 * protocol through Node's built-in WebSocket. Skips cleanly without Chrome.
 *
 * Run with: node tests/socket-budget.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { createSessionStore } = require('../lib/sessions');
const { createPlanCanvasServer } = require('../lib/server');

const CHROME = process.env.EDDIE_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAX_STREAMS = 4;          // the ration under test
const LOAD_DEADLINE_MS = 8000;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    results.push(true);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.stack || err.message}`);
    results.push(false);
    return false;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50, what = 'condition' } = {}) {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return Date.now() - startedAt;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${what} (${timeoutMs}ms)`);
    await sleep(intervalMs);
  }
}

// --- CDP ------------------------------------------------------------------

function launchChrome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eddie-cdp-'));
  const child = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('no DevTools endpoint:\n' + buf)), 20000);
    child.stderr.on('data', d => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve({ child, wsUrl: m[1], dir }); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`chrome exited ${code}\n${buf}`)); });
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      const slot = msg.id && this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
    });
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

// A starved tab blocks its own renderer and never answers, so every call is
// raced against a deadline: the wedge must be reported, not joined.
async function evaluate(cdp, sessionId, expression, timeoutMs = 1500) {
  const call = cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    .then(r => (r.result ? r.result.value : undefined))
    .catch(() => undefined);
  return Promise.race([call, sleep(timeoutMs).then(() => undefined)]);
}

async function openTab(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  // Never awaited: a starved navigation does not commit, so Page.navigate
  // itself hangs. Readiness is polled from the page instead.
  cdp.send('Page.navigate', { url }, sessionId).catch(() => {});
  return sessionId;
}

function canvasLoaded(cdp, sessionId, key) {
  return async () => (await evaluate(cdp, sessionId,
    `location.pathname === '/canvas/${key}' && document.readyState === 'complete' && !!document.getElementById('artifact')`
  )) === true;
}

// Drive visibility explicitly: headless tab visibility is not deterministic,
// and the contract under test is "the page reacts to visibilitychange".
async function setHidden(cdp, sessionId, hidden) {
  const state = hidden ? 'hidden' : 'visible';
  const got = await evaluate(cdp, sessionId, `(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => ${hidden} });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => '${state}' });
    document.dispatchEvent(new Event('visibilitychange'));
    return document.visibilityState;
  })()`);
  assert.strictEqual(got, state, `tab did not accept visibilityState=${state}`);
}

const presenceState = (cdp, sessionId) =>
  evaluate(cdp, sessionId, "document.getElementById('presence').getAttribute('data-state')");

const clickPresence = (cdp, sessionId) =>
  evaluate(cdp, sessionId, "document.getElementById('presence').click(), true");

// --- suite ----------------------------------------------------------------

async function main() {
  console.log('\n=== Testing Eddie socket budget (real Chrome over CDP) ===\n');

  if (!fs.existsSync(CHROME)) {
    console.log(`  ↷ skipped: no Chrome at ${CHROME} (set EDDIE_TEST_CHROME)`);
    console.log('\nPassed: 0\nFailed: 0');
    return 0;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eddie-sockets-'));
  const store = createSessionStore({ stateDir: path.join(tmp, 'state') });
  const canvas = createPlanCanvasServer({ store, version: '9.9.9-test', idleTimeoutMs: 0, maxStreams: MAX_STREAMS });
  await canvas.listen(0);
  const port = canvas.server.address().port;

  // Live event streams and artifact traffic, straight off the wire.
  const streams = new Set();
  let peakStreams = 0;
  const artifactHits = [];
  canvas.server.on('request', (req, res) => {
    if (req.url.startsWith('/events/')) {
      streams.add(res);
      peakStreams = Math.max(peakStreams, streams.size);
      req.on('close', () => streams.delete(res));
    } else if (req.url.startsWith('/artifact/')) {
      artifactHits.push({ method: req.method, url: req.url });
    }
  });
  const hitsFor = (key, method) =>
    artifactHits.filter(h => h.url.startsWith(`/artifact/${key}/`) && h.method === method).length;

  let made = 0;
  function newArtifact() {
    const file = path.join(tmp, `art-${made++}.html`);
    fs.writeFileSync(file, `<!DOCTYPE html><html><body><h1>Artifact ${made}</h1></body></html>`);
    return { file, key: store.open(file).session.key };
  }

  const { child, wsUrl, dir } = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);

  // Open a canvas and wait until it is actually up. Visible by default: the
  // interesting cases are the ones where canvases compete for the budget.
  async function openCanvas({ hidden = false } = {}) {
    const { file, key } = newArtifact();
    const sessionId = await openTab(cdp, `http://127.0.0.1:${port}/canvas/${key}`);
    const ms = await waitFor(canvasLoaded(cdp, sessionId, key), {
      timeoutMs: LOAD_DEADLINE_MS,
      what: `canvas ${key} to load`
    });
    await waitFor(() => hitsFor(key, 'HEAD') > 0, { what: 'its artifact baseline' });
    await setHidden(cdp, sessionId, hidden);
    return { file, key, sessionId, ms };
  }

  try {
    await test('B: a hidden canvas hands its stream back, and reclaims it on return', async () => {
      const a = await openCanvas();
      const b = await openCanvas();
      await waitFor(() => streams.size === 2, { what: 'two live canvases' });

      await setHidden(cdp, b.sessionId, true);
      await waitFor(() => streams.size === 1, { what: 'the hidden canvas to release its stream' });

      await setHidden(cdp, b.sessionId, false);
      await waitFor(() => streams.size === 2, { what: 'the returning canvas to reconnect' });

      // Two canvases are well inside the ration, so neither is paused.
      assert.notStrictEqual(await presenceState(cdp, a.sessionId), 'paused');
      assert.notStrictEqual(await presenceState(cdp, b.sessionId), 'paused');
    });

    // Everything below shares this crowd: more visible canvases than the
    // ration allows, which is exactly the situation that used to wedge.
    const crowd = [];
    await test(`D: live streams never exceed the ration of ${MAX_STREAMS}, and the yielded canvas says so`, async () => {
      while (crowd.length < MAX_STREAMS + 2) crowd.push(await openCanvas());
      assert.ok(streams.size <= MAX_STREAMS, `live streams ${streams.size} exceeded the ration`);
      // One over is the unavoidable in-flight connection: the server can only
      // ration a stream once its request has landed, and it evicts before
      // registering it. Anything beyond that is a real leak.
      assert.ok(peakStreams <= MAX_STREAMS + 1, `live streams peaked at ${peakStreams}, over the ration`);

      // The canvas looked at longest ago yielded — and shows it rather than
      // going quietly stale.
      await waitFor(async () => (await presenceState(cdp, crowd[0].sessionId)) === 'paused',
        { what: 'the oldest canvas to report its feed paused' });

      // Every canvas still rendered its document: nothing was starved.
      for (const c of crowd) assert.ok(hitsFor(c.key, 'GET') > 0, `canvas ${c.key} never loaded its artifact`);
    });

    await test('D: clicking the paused canvas takes the live feed back', async () => {
      await clickPresence(cdp, crowd[0].sessionId);
      await waitFor(async () => (await presenceState(cdp, crowd[0].sessionId)) !== 'paused',
        { what: 'the paused canvas to resume' });
      assert.ok(streams.size <= MAX_STREAMS, 'resuming must not break the ration');
    });

    await test(`A: a fresh canvas still loads with ${MAX_STREAMS + 2} canvases already open`, async () => {
      const fresh = await openCanvas();
      console.log(`      (loaded in ${fresh.ms}ms)`);
      assert.ok(streams.size <= MAX_STREAMS, 'the ration held while a new canvas opened');
    });

    await test('C: returning to a parked canvas reloads an artifact that changed', async () => {
      const c = await openCanvas();
      await setHidden(cdp, c.sessionId, true);
      const before = hitsFor(c.key, 'GET');
      fs.writeFileSync(c.file, '<!DOCTYPE html><html><body><h1>rewritten while parked</h1></body></html>');
      await sleep(300); // the watcher fires into the void: nobody is listening
      await setHidden(cdp, c.sessionId, false);
      await waitFor(() => hitsFor(c.key, 'GET') > before, { what: 'the changed artifact to be re-fetched' });
    });

    await test('C: returning to an unchanged canvas does not reload it', async () => {
      const c = await openCanvas();
      await setHidden(cdp, c.sessionId, true);
      const before = hitsFor(c.key, 'GET');
      await setHidden(cdp, c.sessionId, false);
      await waitFor(() => hitsFor(c.key, 'HEAD') >= 2, { what: 'the return check' });
      await sleep(600); // a debounced reload would have landed by now
      assert.strictEqual(hitsFor(c.key, 'GET'), before, 'unchanged artifact must not be re-fetched');
    });
  } finally {
    // Always: a failed run used to leave a headless Chrome alive, holding
    // sockets and answering Apple Events as if it were the real browser.
    child.kill('SIGKILL');
    await canvas.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log('\n' + '='.repeat(40));
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log('='.repeat(40));
  return failed > 0 ? 1 : 0;
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    console.log('Passed: 0');
    console.log('Failed: 1');
    process.exit(1);
  });
