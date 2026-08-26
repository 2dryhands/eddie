/**
 * Socket-budget tests: Eddie in a real Chrome, driven over CDP.
 *
 * The bug these guard against (2026-08-26): every open canvas tab held its
 * event-stream socket open for the life of the tab. Chrome allows six sockets
 * per origin over HTTP/1.1, so six canvases left open — the normal way a
 * dashboard lives here — starved the origin: the next canvas queued behind
 * them and never loaded at all. Its renderer wedged so hard it stopped
 * answering CDP. Safari has its own pool, so pasting the same URL there
 * always worked, which hid the cause through four rounds of white-screen
 * patches on the canvas side.
 *
 * Gates:
 *   A  a fresh canvas still loads with six canvases already open
 *   B  a hidden canvas holds no event-stream socket
 *   C  returning to a parked canvas reconnects, and reloads the artifact
 *      only when the file actually changed
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
const VISIBLE_TABS = 6;   // Chrome's per-origin socket budget over HTTP/1.1
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
  const ok = await evaluate(cdp, sessionId, `(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => ${hidden} });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => '${state}' });
    document.dispatchEvent(new Event('visibilitychange'));
    return document.visibilityState;
  })()`);
  assert.strictEqual(ok, state, `tab did not accept visibilityState=${state}`);
}

// --- suite ----------------------------------------------------------------

async function main() {
  console.log('\n=== Testing Eddie socket budget (real Chrome over CDP) ===\n');

  if (!fs.existsSync(CHROME)) {
    console.log(`  ↷ skipped: no Chrome at ${CHROME} (set EDDIE_TEST_CHROME)`);
    console.log('\nPassed: 0\nFailed: 0');
    return process.exit(0);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eddie-sockets-'));
  const store = createSessionStore({ stateDir: path.join(tmp, 'state') });
  const canvas = createPlanCanvasServer({ store, version: '9.9.9-test', idleTimeoutMs: 0 });
  await canvas.listen(0);
  const port = canvas.server.address().port;

  // Live event streams and artifact traffic, straight off the wire.
  const streams = new Set();
  const artifactHits = [];
  canvas.server.on('request', (req, res) => {
    if (req.url.startsWith('/events/')) {
      streams.add(res);
      req.on('close', () => streams.delete(res));
    } else if (req.url.startsWith('/artifact/')) {
      artifactHits.push({ method: req.method, url: req.url });
    }
  });
  const hitsFor = (key, method) =>
    artifactHits.filter(h => h.url.startsWith(`/artifact/${key}/`) && h.method === method).length;

  const keys = [];
  const files = [];
  for (let i = 0; i <= VISIBLE_TABS; i++) {
    const file = path.join(tmp, `art-${i}.html`);
    fs.writeFileSync(file, `<!DOCTYPE html><html><body><h1>Artifact ${i}</h1></body></html>`);
    files.push(file);
    keys.push(store.open(file).session.key);
  }

  const { child, wsUrl, dir } = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);
  const tabs = [];

  if ((await test(`${VISIBLE_TABS} visible canvases each hold one event stream`, async () => {
    for (let i = 0; i < VISIBLE_TABS; i++) {
      const sessionId = await openTab(cdp, `http://127.0.0.1:${port}/canvas/${keys[i]}`);
      tabs.push(sessionId);
      await waitFor(canvasLoaded(cdp, sessionId, keys[i]), { timeoutMs: LOAD_DEADLINE_MS, what: `tab ${i} to load` });
      await setHidden(cdp, sessionId, false);
    }
    await waitFor(() => streams.size === VISIBLE_TABS, { what: `${VISIBLE_TABS} live streams` });
    // Every canvas has recorded what its frame is showing (Gate C's baseline).
    await waitFor(() => keys.slice(0, VISIBLE_TABS).every(k => hitsFor(k, 'HEAD') > 0), { what: 'artifact HEAD baselines' });
  }))) { /* baseline holds */ } else throw new Error('baseline failed — later gates would be meaningless');

  await test('Gate B: a hidden canvas gives its event-stream socket back', async () => {
    for (let i = 1; i < VISIBLE_TABS; i++) await setHidden(cdp, tabs[i], true);
    await waitFor(() => streams.size === 1, { what: 'parked tabs to release their streams' });
    assert.strictEqual(streams.size, 1, 'only the visible canvas should hold a stream');
  });

  await test(`Gate A: a fresh canvas still loads with ${VISIBLE_TABS} canvases open`, async () => {
    const last = VISIBLE_TABS;
    const sessionId = await openTab(cdp, `http://127.0.0.1:${port}/canvas/${keys[last]}`);
    tabs.push(sessionId);
    const ms = await waitFor(canvasLoaded(cdp, sessionId, keys[last]), {
      timeoutMs: LOAD_DEADLINE_MS,
      what: `canvas ${last + 1} to load behind ${VISIBLE_TABS} open canvases`
    });
    console.log(`      (loaded in ${ms}ms)`);
  });

  await test('Gate C: returning to a parked canvas reloads an artifact that changed', async () => {
    const i = 1;
    const before = hitsFor(keys[i], 'GET');
    const streamsBefore = streams.size;
    fs.writeFileSync(files[i], '<!DOCTYPE html><html><body><h1>Artifact 1 — rewritten</h1></body></html>');
    await sleep(300); // let the watcher fire into the void: nobody is listening
    await setHidden(cdp, tabs[i], false);
    await waitFor(() => hitsFor(keys[i], 'GET') > before, { what: 'the changed artifact to be re-fetched' });
    await waitFor(() => streams.size === streamsBefore + 1, { what: 'the returning canvas to reconnect' });
  });

  await test('Gate C: returning to an unchanged canvas does not reload it', async () => {
    const i = 2;
    const before = hitsFor(keys[i], 'GET');
    await setHidden(cdp, tabs[i], false);
    await waitFor(() => hitsFor(keys[i], 'HEAD') >= 2, { what: 'the return check' });
    await sleep(600); // a debounced reload would have landed by now
    assert.strictEqual(hitsFor(keys[i], 'GET'), before, 'unchanged artifact must not be re-fetched');
  });

  child.kill('SIGKILL');
  await canvas.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log('\n' + '='.repeat(40));
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log('='.repeat(40));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  console.log('Passed: 0');
  console.log('Failed: 1');
  process.exit(1);
});
