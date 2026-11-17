/**
 * Closed-page tests: a note typed into a tab whose page was closed must not
 * die in that tab (2026-11-17). Real Chrome over CDP, skips without Chrome.
 *
 *   A  agent closed the page while the tab was open: the tab stays usable,
 *      a typed note posts, the page reopens and the note reaches await
 *   B  the reviewer closed the page: sending shows the reopen card, the typed
 *      text survives, "Reopen" sends it
 *   C  the server restarted under the tab: a send while it is down says
 *      "not sent" and keeps the text; once it is back, Send delivers it
 *
 * Run with: node tests/closed-page.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSessionStore } = require('../lib/sessions');
const { createPlanCanvasServer } = require('../lib/server');
const { CHROME, waitFor, launchChrome, Cdp, evaluate } = require('./cdp');

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

async function main() {
  console.log('\n=== Testing notes on closed pages (real Chrome over CDP) ===\n');
  if (!fs.existsSync(CHROME)) {
    console.log(`  ↷ skipped: no Chrome at ${CHROME} (set EDDIE_TEST_CHROME)`);
    console.log('\nPassed: 0\nFailed: 0');
    return 0;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eddie-closed-'));
  const store = createSessionStore({ stateDir: path.join(tmp, 'state') });
  let canvas = createPlanCanvasServer({ store, version: '9.9.9-test', idleTimeoutMs: 0 });
  await canvas.listen(0);
  const port = canvas.server.address().port;
  const { child, wsUrl, dir } = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);

  let made = 0;
  async function openCanvas() {
    const file = path.join(tmp, `page-${made++}.html`);
    fs.writeFileSync(file, '<!DOCTYPE html><html><body><h1>Page</h1></body></html>');
    const key = store.open(file).session.key;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/canvas/${key}` }, sessionId).catch(() => {});
    const js = expr => evaluate(cdp, sessionId, expr);
    await waitFor(async () => (await js("document.readyState === 'complete' && document.getElementById('presence').getAttribute('data-state') === 'waiting'")) === true,
      { timeoutMs: 8000, what: 'canvas up with a live feed' });
    return { file, key, js };
  }
  const type = (js, text) => js(`(() => { const i = document.getElementById('chatInput'); i.value = ${JSON.stringify(text)}; document.getElementById('send').click(); return true; })()`);

  try {
    await test('A: agent closes the page under an open tab — a typed note still lands and reopens it', async () => {
      const { key, js } = await openCanvas();
      await fetch(`http://127.0.0.1:${port}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: store.get(key).file }) });
      await waitFor(async () => (await js("document.getElementById('presence').getAttribute('data-state')")) === 'ended', { what: 'tab to hear the close' });
      assert.strictEqual(await js("document.getElementById('endedOverlay').classList.contains('show')"), false, 'no lock card for an agent close');
      assert.strictEqual(await js("document.getElementById('chatInput').disabled"), false, 'composer stays usable');
      await type(js, 'note after the agent left');
      await waitFor(() => store.get(key).pendingFeedback.length === 1, { what: 'note to reach the server' });
      assert.notStrictEqual(store.get(key).status, 'ended', 'page reopened');
      assert.strictEqual(store.takeFeedback(key).items[0].text, 'note after the agent left');
    });

    await test('B: reviewer closed the page — send shows Reopen, typed text survives, Reopen sends it', async () => {
      const { key, js } = await openCanvas();
      store.end(key, 'user'); // closed from another tab: this one never heard it
      await type(js, 'second thoughts');
      await waitFor(async () => (await js("document.getElementById('endedOverlay').classList.contains('show')")) === true, { what: 'reopen card' });
      assert.strictEqual(await js("document.getElementById('chatInput').value"), 'second thoughts', 'typed text kept');
      assert.strictEqual(store.get(key).pendingFeedback.length, 0);
      await js("document.getElementById('reopenBtn').click(), true");
      await waitFor(() => store.get(key).pendingFeedback.length === 1, { what: 'reopen to send the kept text' });
      assert.strictEqual(store.get(key).pendingFeedback[0].text, 'second thoughts');
      await waitFor(async () => (await js("document.getElementById('endedOverlay').classList.contains('show')")) === false, { what: 'card gone' });
    });

    await test('C: server restart under an open tab — honest failure while down, delivered after', async () => {
      const { key, js } = await openCanvas();
      await canvas.close();
      await type(js, 'typed during the restart');
      await waitFor(async () => /\(/.test(await js("document.getElementById('sendStatus').textContent")), { what: 'failure message' });
      assert.match(await js("document.getElementById('sendStatus').textContent"), /Send again|ещё раз/);
      assert.strictEqual(await js("document.getElementById('chatInput').value"), 'typed during the restart', 'text kept');
      const reloaded = createSessionStore({ stateDir: path.join(tmp, 'state') }); // a real restart re-reads disk
      canvas = createPlanCanvasServer({ store: reloaded, version: '9.9.9-test', idleTimeoutMs: 0 });
      await canvas.listen(port);
      await js("document.getElementById('send').click(), true");
      await waitFor(() => reloaded.get(key).pendingFeedback.length === 1, { what: 'resend after restart' });
      assert.strictEqual(reloaded.get(key).pendingFeedback[0].text, 'typed during the restart');
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
