/**
 * Form drafts survive an artifact reload — Eddie in a real Chrome over CDP.
 *
 * The bug (2026-11-14): a dashboard with reply boxes on its cards is
 * rebuilt on disk all the time. Every rebuild made the chrome recreate the
 * sandboxed iframe, and whatever the reviewer had typed but not sent was gone.
 * The page can't keep it itself: the sandbox has no storage, and window.name
 * dies with the iframe element. So the SDK reports fields to the chrome, and
 * the chrome hands them back after the reload.
 *
 * Gates:
 *   1  text typed into a field is back in the same field after a rebuild;
 *      the other field stays empty, and the caret is still in the field
 *   2  once the page clears the field itself (sent), the old text stays gone
 *   3  a draft for a field the new build no longer has is dropped quietly
 *   4  restoring never makes Eddie write the file (a field inside a
 *      live-edit text block used to trigger a save over the agent's write)
 *   5  a draft never covers new text the agent put in the field
 *   6  a page setting thousands of field values stays fast (no O(n²))
 *   7  a hostile page can't flood the chrome's storage through pc:draft
 *   8  two cards copied with the same field id keep separate drafts
 *   9  a form cleared with form.reset() after sending forgets the draft
 *
 * Run with: node tests/drafts.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSessionStore } = require('../lib/sessions');
const { createPlanCanvasServer } = require('../lib/server');
const { CHROME, sleep, waitFor, launchChrome, Cdp, evaluate } = require('./cdp');

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

// Reply cards keyed by data-to, a bare <textarea> inside each.
// "Send" mimics a page that clears its own field once the reply is out.
function card(to) {
  return `<article data-to="${to}"><p>Card ${to}</p><textarea></textarea>` +
    `<button class="send" onclick="this.closest('[data-to]').querySelector('textarea').value=''">Send</button></article>`;
}
function page(build, cards, extra = '') {
  return `<!DOCTYPE html><html><body><h1>build ${build}</h1>${cards.map(card).join('')}${extra}</body></html>`;
}

async function main() {
  console.log('\n=== Testing Eddie form drafts across reloads (real Chrome over CDP) ===\n');

  if (!fs.existsSync(CHROME)) {
    console.log(`  ↷ skipped: no Chrome at ${CHROME} (set EDDIE_TEST_CHROME)`);
    console.log('\nPassed: 0\nFailed: 0');
    return 0;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eddie-drafts-'));
  const store = createSessionStore({ stateDir: path.join(tmp, 'state') });
  const canvas = createPlanCanvasServer({ store, version: '9.9.9-test', idleTimeoutMs: 0 });
  await canvas.listen(0);
  const port = canvas.server.address().port;

  const file = path.join(tmp, 'cards.html');
  let build = 1;
  fs.writeFileSync(file, page(build, ['a', 'b']));
  // Open over the API, like an agent does: that is what arms the file watcher.
  const opened = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file })
  }).then(r => r.json());
  const key = opened.key;
  function rebuild(cards, extra) { fs.writeFileSync(file, page(++build, cards, extra)); }

  const { child, wsUrl, dir } = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);

  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);

    // The artifact lives in a sandboxed iframe, which Chrome runs in its own
    // process — a separate CDP target. Auto-attach hands us each one as the
    // chrome recreates it on reload; the newest is the frame on screen. Paused
    // on start so console/exception capture is on before the page runs.
    let frameSession = null;
    cdp.onEvent = msg => {
      if (msg.method !== 'Target.attachedToTarget' || msg.params.targetInfo.type !== 'iframe') return;
      const sid = msg.params.sessionId;
      frameSession = sid;
      cdp.send('Runtime.enable', {}, sid)
        .then(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, sid)).catch(() => {});
    };
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/canvas/${key}` }, sessionId).catch(() => {});
    const inFrame = expression => (frameSession ? evaluate(cdp, frameSession, expression) : Promise.resolve(undefined));
    const veilDown = async () => (await evaluate(cdp, sessionId,
      "!!document.getElementById('artifact') && !document.getElementById('loadVeil').classList.contains('show')")) === true;
    // A build is "in" when the frame shows it and the chrome has had pc:ready;
    // the short settle lets the drafts message land (or, for the negative
    // gates, gives a wrong restore the chance to show up).
    async function waitBuild(n) {
      await waitFor(async () => (await inFrame("document.querySelector('h1') && document.querySelector('h1').textContent")) === `build ${n}`,
        { timeoutMs: 8000, what: `build ${n} in the frame` });
      await waitFor(veilDown, { timeoutMs: 8000, what: `pc:ready for build ${n}` });
      await sleep(300);
    }
    const values = () => inFrame("JSON.stringify(Array.from(document.querySelectorAll('textarea')).map(t => t.value))")
      .then(v => JSON.parse(v || 'null'));
    async function typeInto(index, text) {
      assert.strictEqual(await inFrame(`(document.querySelectorAll('textarea')[${index}].focus(), document.activeElement.tagName)`), 'TEXTAREA');
      await cdp.send('Input.insertText', { text }, sessionId); // trusted input, like a keyboard
      await sleep(150);
    }

    await waitBuild(1);
    // Headless visibility is not deterministic, and a hidden canvas parks its
    // event stream (no live reloads). The reviewer is looking at this one.
    assert.strictEqual(await evaluate(cdp, sessionId, `(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      return document.visibilityState;
    })()`), 'visible');
    await sleep(300);

    await test('1: typed text is back in the same field after a rebuild, the other stays empty', async () => {
      await typeInto(0, 'пишу-пишу, не отправил');
      assert.deepStrictEqual(await values(), ['пишу-пишу, не отправил', '']);
      rebuild(['a', 'b']);
      await waitBuild(build);
      assert.deepStrictEqual(await values(), ['пишу-пишу, не отправил', ''], 'draft lost or landed in the wrong field');
    });

    await test('1: the caret is still in that field, so the next keystrokes land there', async () => {
      assert.strictEqual(await inFrame("document.activeElement === document.querySelectorAll('textarea')[0]"), true,
        'focus did not come back to the field being typed in');
      await cdp.send('Input.insertText', { text: '!' }, sessionId);
      await sleep(100);
      assert.strictEqual((await values())[0], 'пишу-пишу, не отправил!');
    });

    await test('2: after the page clears the field (sent), a rebuild does not bring the text back', async () => {
      await inFrame("document.querySelector('[data-to=\"a\"] .send').click(), true");
      assert.deepStrictEqual(await values(), ['', '']);
      rebuild(['a', 'b']);
      await waitBuild(build);
      assert.deepStrictEqual(await values(), ['', ''], 'a sent reply came back as a draft');
    });

    await test('3: a draft for a card the new build dropped is skipped quietly', async () => {
      await typeInto(1, 'ответ карточке b');
      const errorsBefore = cdp.events.length;
      rebuild(['a']); // card b answered elsewhere and gone
      await waitBuild(build);
      assert.deepStrictEqual(await values(), [''], 'card b draft leaked into card a');
      const errors = cdp.events.slice(errorsBefore).filter(e =>
        e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
      assert.deepStrictEqual(errors.map(e => JSON.stringify(e.params).slice(0, 300)), [], 'console errors on reload');
      // …and it is not lost for good: if card b comes back, so does its text.
      rebuild(['a', 'b']);
      await waitBuild(build);
      assert.deepStrictEqual(await values(), ['', 'ответ карточке b']);
    });

    await test('4: restoring a draft inside a live-edit text block does not write the file', async () => {
      const li = '<ul><li>Reply: <textarea></textarea></li></ul>';
      rebuild([], li);
      await waitBuild(build);
      await typeInto(0, 'в пункте списка');
      rebuild([], li);
      const written = fs.readFileSync(file, 'utf8');
      await waitBuild(build);
      assert.deepStrictEqual(await values(), ['в пункте списка']);
      await sleep(1500); // a live-edit save lands ~650 ms after the input
      assert.strictEqual(fs.readFileSync(file, 'utf8'), written, 'Eddie rewrote the artifact on restore');
    });

    await test('5: a draft does not cover new text the agent put into the field', async () => {
      const pre = v => `<article data-to="pre"><textarea>suggestion ${v}</textarea></article>`;
      rebuild([], pre('v1'));
      await waitBuild(build);
      await inFrame("(() => { const t = document.querySelector('textarea'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()");
      await cdp.send('Input.insertText', { text: ' + my edit' }, sessionId);
      await sleep(150);
      rebuild([], pre('v1')); // same suggestion: the edit comes back
      await waitBuild(build);
      assert.deepStrictEqual(await values(), ['suggestion v1 + my edit']);
      rebuild([], pre('v2')); // the agent rewrote it: its text wins
      await waitBuild(build);
      assert.deepStrictEqual(await values(), ['suggestion v2']);
      rebuild([], pre('v2')); // and the stale draft is gone for good
      await waitBuild(build);
      assert.deepStrictEqual(await values(), ['suggestion v2']);
    });

    await test('6: a page filling 3000 fields by script stays fast', async () => {
      const ms = await inFrame(`(() => {
        const box = document.createElement('div');
        box.innerHTML = '<input>'.repeat(3000);
        document.body.appendChild(box);
        const t0 = performance.now();
        box.querySelectorAll('input').forEach((el, i) => { el.value = String(i); });
        return performance.now() - t0;
      })()`);
      console.log(`      (${Math.round(ms)}ms)`);
      assert.ok(ms < 300, `setting 3000 values took ${Math.round(ms)}ms`);
    });

    await test('7: a page flooding pc:draft cannot fill the chrome storage', async () => {
      await inFrame(`(() => {
        for (let i = 0; i < 300; i++) parent.postMessage({ type: 'pc:draft', key: 'k' + i, value: 'x'.repeat(49000), base: '' }, '*');
        parent.postMessage({ type: 'pc:draft', key: 'k'.repeat(100000), value: 'y', base: '' }, '*');
        return true;
      })()`);
      await sleep(1500);
      const size = await evaluate(cdp, sessionId,
        "Object.keys(localStorage).filter(k => k.startsWith('eddie-drafts:')).reduce((n, k) => n + localStorage.getItem(k).length, 0)", 5000);
      assert.ok(size > 0 && size <= 400000, `drafts storage is ${size} chars`);
      assert.strictEqual(await evaluate(cdp, sessionId, "(() => { try { localStorage.setItem('probe', 'x'.repeat(100000)); localStorage.removeItem('probe'); return true; } catch (e) { return e.name; } })()"), true);
    });

    await test('8: two cards copied with the same field id keep separate drafts', async () => {
      const dup = '<article data-to="x"><textarea id="reply"></textarea></article><article data-to="y"><textarea id="reply"></textarea></article>';
      rebuild([], dup);
      await waitBuild(build);
      await typeInto(0, 'ответ X');
      await typeInto(1, 'ответ Y');
      rebuild([], dup);
      await waitBuild(build);
      assert.deepStrictEqual(await values(), ['ответ X', 'ответ Y']);
    });

    await test('9: a form cleared with form.reset() after sending forgets the draft', async () => {
      const form = '<form onsubmit="event.preventDefault(); this.reset()"><textarea name="m"></textarea><button>Send</button></form>';
      rebuild([], form);
      await waitBuild(build);
      await typeInto(0, 'sent text');
      await inFrame("document.querySelector('form button').click(), true");
      await sleep(200);
      assert.deepStrictEqual(await values(), ['']);
      rebuild([], form);
      await waitBuild(build);
      assert.deepStrictEqual(await values(), [''], 'a reset form got its sent text back');
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
