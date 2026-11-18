/**
 * Live feed and page storage — Eddie in a real Chrome over CDP.
 *
 * Spec 2026-11-18 (pult live inbox), Eddie part:
 *   1  writing X.feed.json reaches the open page as pc:feed, no reload
 *   2  a fresh iframe (the page was rebuilt) gets the current feed after pc:ready
 *   3  sessionStorage written by the page is back for a synchronous <head>
 *      script after the iframe is recreated; another page does not see it
 *
 * Run with: node tests/live-feed.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSessionStore } = require('../lib/sessions');
const { createPlanCanvasServer } = require('../lib/server');
const { SKIP, sleep, waitFor, launchChrome, Cdp, evaluate } = require('./cdp');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    results.push(true);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.stack || err.message}`);
    results.push(false);
  }
}

// The <head> script runs before anything else of the page: what it reads is
// what a real page (the pult's filter) would read at load.
function page(build) {
  return '<!DOCTYPE html><html><head><script>' +
    "window.filt = sessionStorage.getItem('filt:/p'); window.feeds = [];" +
    "addEventListener('message', e => { if (e.data && e.data.type === 'pc:feed') feeds.push(e.data.feed); });" +
    `</script></head><body><h1>build ${build}</h1></body></html>`;
}

async function main() {
  console.log('\n=== Testing Eddie live feed and page storage (real Chrome over CDP) ===\n');

  if (SKIP) {
    console.log(`  ↷ skipped: ${SKIP}`);
    console.log('\nPassed: 0\nFailed: 0');
    return 0;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eddie-feed-'));
  const store = createSessionStore({ stateDir: path.join(tmp, 'state') });
  const canvas = createPlanCanvasServer({ store, version: '9.9.9-test', idleTimeoutMs: 0 });
  await canvas.listen(0);
  const port = canvas.server.address().port;
  const openSession = file => fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file })
  }).then(r => r.json()).then(r => r.key);

  const file = path.join(tmp, 'index.html');
  const feedFile = path.join(tmp, 'index.feed.json');
  const other = path.join(tmp, 'other.html');
  let build = 1;
  fs.writeFileSync(file, page(build));
  fs.writeFileSync(other, page('other'));
  const key = await openSession(file);
  const otherKey = await openSession(other);

  const { child, wsUrl, dir } = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);

  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    let frameSession = null;
    cdp.onEvent = msg => {
      if (msg.method !== 'Target.attachedToTarget' || msg.params.targetInfo.type !== 'iframe') return;
      const sid = msg.params.sessionId;
      frameSession = sid;
      cdp.send('Runtime.enable', {}, sid)
        .then(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, sid)).catch(() => {});
    };
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    const inFrame = expression => (frameSession ? evaluate(cdp, frameSession, expression) : Promise.resolve(undefined));
    const veilDown = async () => (await evaluate(cdp, sessionId,
      "!!document.getElementById('artifact') && !document.getElementById('loadVeil').classList.contains('show')")) === true;
    async function waitBuild(n) {
      await waitFor(async () => (await inFrame("document.querySelector('h1') && document.querySelector('h1').textContent")) === `build ${n}`,
        { timeoutMs: 8000, what: `build ${n} in the frame` });
      await waitFor(veilDown, { timeoutMs: 8000, what: `pc:ready for build ${n}` });
      await sleep(300);
    }
    const feeds = () => inFrame('JSON.stringify(feeds)').then(v => JSON.parse(v || '[]'));
    async function visible() {
      // Headless visibility is not deterministic; a hidden canvas parks its stream.
      await evaluate(cdp, sessionId, `(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      })()`);
      await sleep(300);
    }

    cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/canvas/${key}` }, sessionId).catch(() => {});
    await waitBuild(1);
    await visible();

    await test('1: writing index.feed.json reaches the page as pc:feed, the page is not reloaded', async () => {
      await inFrame('window.marker = 42');
      fs.writeFileSync(feedFile, JSON.stringify({ base: 'b1', posts: [{ id: 'C|1' }], gone: [] }));
      await waitFor(async () => (await feeds()).length > 0, { timeoutMs: 4000, what: 'pc:feed in the frame' });
      assert.deepStrictEqual(await feeds(), [{ base: 'b1', posts: [{ id: 'C|1' }], gone: [] }]);
      await sleep(500);
      assert.strictEqual(await inFrame('window.marker'), 42, 'the frame was recreated on a feed write');
    });

    await test('2: a fresh iframe gets the current feed after pc:ready', async () => {
      fs.writeFileSync(feedFile, JSON.stringify({ base: 'b2', posts: [], gone: [] }));
      await waitFor(async () => (await feeds()).some(f => f.base === 'b2'), { timeoutMs: 4000, what: 'feed b2' });
      fs.writeFileSync(file, page(++build));
      await waitBuild(build);
      await waitFor(async () => (await feeds()).length > 0, { timeoutMs: 3000, what: 'feed in the fresh frame' });
      assert.strictEqual((await feeds()).pop().base, 'b2');
    });

    await test('3: sessionStorage survives the iframe being recreated, read by a sync <head> script', async () => {
      await inFrame("sessionStorage.setItem('filt:/p', 'harness'), true");
      await sleep(400); // the save travels frame → chrome → server
      fs.writeFileSync(file, page(++build));
      await waitBuild(build);
      assert.strictEqual(await inFrame('window.filt'), 'harness');
    });

    await test('3: another page does not see that key', async () => {
      cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/canvas/${otherKey}` }, sessionId).catch(() => {});
      await waitBuild('other');
      assert.strictEqual(await inFrame('window.filt'), null);
    });
  } finally {
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise(r => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
    await canvas.close().catch(() => {});
    const rm = p => fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rm(tmp);
    rm(dir);
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
