/**
 * Images in a note and in the chat reach the agent as file paths.
 *
 * Gates:
 *   1  a PNG upload lands on disk byte for byte; the same picture twice is one file
 *   2  not a picture (text, SVG) → 415; over 10 MB → 413
 *   3  an item's `images: [name]` reaches the agent as an absolute path;
 *      a crafted or unknown name is dropped
 *   4  a note or a chat message with only a picture goes through;
 *      an empty one without a picture still does not
 *   5  real Chrome: paste into the note card → Queue → Send → annotation with the path
 *   6  real Chrome: paste into the chat box → Send → chat item with the path
 *
 * Run with: node tests/images.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSessionStore } = require('../lib/sessions');
const { createPlanCanvasServer } = require('../lib/server');
const { SKIP, sleep, waitFor, launchChrome, closeChrome, Cdp, evaluate } = require('./cdp');

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

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');

async function main() {
  console.log('\n=== Testing images in notes and chat ===\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eddie-images-'));
  const stateDir = path.join(tmp, 'state');
  const store = createSessionStore({ stateDir });
  const canvas = createPlanCanvasServer({ store, version: '9.9.9-test', idleTimeoutMs: 0 });
  await canvas.listen(0);
  const port = canvas.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const file = path.join(tmp, 'plan.html');
  fs.writeFileSync(file, '<!DOCTYPE html><html><body><h1>Plan</h1><p id="target">Hero block</p></body></html>');
  const { key } = await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file })
  }).then(r => r.json());
  const upload = (body, type = 'image/png') => fetch(`${base}/api/session/${key}/image`, { method: 'POST', headers: { 'content-type': type }, body });
  const feedback = items => fetch(`${base}/api/session/${key}/feedback`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items })
  }).then(r => r.json());

  let name;
  try {
    await test('1: a PNG lands on disk byte for byte, the same picture twice is one file', async () => {
      const res = await upload(PNG);
      assert.strictEqual(res.status, 200);
      name = (await res.json()).image;
      assert.match(name, /^[a-f0-9]{16}\.png$/);
      assert.deepStrictEqual(fs.readFileSync(path.join(stateDir, 'images', name)), PNG);
      assert.strictEqual((await (await upload(PNG)).json()).image, name);
      assert.strictEqual(fs.readdirSync(path.join(stateDir, 'images')).length, 1);
    });

    await test('2: text and SVG are refused (415), over 10 MB too (413)', async () => {
      assert.strictEqual((await upload('hello', 'image/png')).status, 415);
      assert.strictEqual((await upload('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml')).status, 415);
      const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
      const res = await upload(big).catch(() => ({ status: 413 })); // the server may cut the socket mid-upload
      assert.strictEqual(res.status, 413);
    });

    await test('3: images reach the agent as absolute paths; crafted and unknown names are dropped', async () => {
      await feedback([{ kind: 'annotation', text: 'like this', anchor: { selector: '#target', tag: 'p', snippet: 'Hero' },
        images: [name, '../sessions.json', 'ffffffffffffffff.png', 42] }]);
      const { items } = store.takeFeedback(key);
      assert.strictEqual(items.length, 1);
      assert.deepStrictEqual(items[0].images, [path.join(stateDir, 'images', name)]);
      assert.deepStrictEqual(fs.readFileSync(items[0].images[0]), PNG);
    });

    await test('4: a picture alone is a note / a message; empty without one is not', async () => {
      const r = await feedback([
        { kind: 'annotation', text: '', anchor: { selector: '#target' }, images: [name] },
        { kind: 'chat', text: '', images: [name] },
        { kind: 'chat', text: '' },
        { kind: 'chat', text: '', images: ['nope.png'] }
      ]);
      assert.strictEqual(r.accepted, 2);
      const { items } = store.takeFeedback(key);
      assert.deepStrictEqual(items.map(i => [i.kind, i.images.length]), [['annotation', 1], ['chat', 1]]);
      assert.match(store.get(key).chat.slice(-1)[0].text, /🖼/, 'the chat line does not mark the picture');
    });

    if (SKIP) {
      console.log(`  ↷ browser gates skipped: ${SKIP}`);
      return finish();
    }

    const { child, wsUrl, dir } = await launchChrome();
    const cdp = await Cdp.connect(wsUrl);
    try {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Runtime.enable', {}, sessionId);
      let frameSession = null;
      cdp.onEvent = msg => {
        if (msg.method !== 'Target.attachedToTarget' || msg.params.targetInfo.type !== 'iframe') return;
        frameSession = msg.params.sessionId;
        cdp.send('Runtime.enable', {}, frameSession)
          .then(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, frameSession)).catch(() => {});
      };
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
      cdp.send('Page.navigate', { url: `${base}/canvas/${key}` }, sessionId).catch(() => {});
      const top = expr => evaluate(cdp, sessionId, expr);
      const inFrame = expr => (frameSession ? evaluate(cdp, frameSession, expr) : Promise.resolve(undefined));
      await waitFor(async () => (await top("!!document.getElementById('loadVeil') && !document.getElementById('loadVeil').classList.contains('show')")) === true,
        { timeoutMs: 10000, what: 'pc:ready' });
      // A paste carrying a PNG file, the way the browser hands a screenshot from the clipboard.
      const pasteInto = (where, selector) => where(`(() => {
        const bytes = Uint8Array.from(atob('${PNG_B64}'), c => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
        const el = ${selector};
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
        return true;
      })()`);

      await test('5: a picture pasted into the note card reaches the agent with its path', async () => {
        await waitFor(async () => {
          await inFrame("document.getElementById('target').click(), 1");
          await sleep(150);
          return (await inFrame("getComputedStyle(document.querySelector('[data-eddie=ui]').shadowRoot.querySelector('.card')).display")) === 'block';
        }, { timeoutMs: 6000, intervalMs: 200, what: 'the note card' });
        const cardRoot = "document.querySelector('[data-eddie=ui]').shadowRoot";
        assert.strictEqual(await pasteInto(inFrame, `${cardRoot}.querySelector('.click-text')`), true);
        await waitFor(async () => (await inFrame(`${cardRoot}.querySelectorAll('.thumbs img').length`)) === 1,
          { timeoutMs: 3000, what: 'the thumbnail in the note card' });
        await inFrame(`(${cardRoot}.querySelector('.click-text').value = 'make it like this', ${cardRoot}.querySelector('.queue').click(), 1)`);
        await waitFor(async () => /🖼/.test(await top("document.getElementById('queue').textContent")),
          { timeoutMs: 4000, what: 'the note with a picture in the queue' });
        await top("document.getElementById('send').click(), 1");
        let got;
        await waitFor(() => { got = store.takeFeedback(key); return got.status === 'feedback'; }, { timeoutMs: 4000, what: 'the note at the agent' });
        const note = got.items.find(i => i.kind === 'annotation');
        assert.ok(note, JSON.stringify(got));
        assert.strictEqual(note.text, 'make it like this');
        assert.strictEqual(note.images.length, 1);
        assert.deepStrictEqual(fs.readFileSync(note.images[0]), PNG);
      });

      await test('6: a picture pasted into the chat box reaches the agent with its path', async () => {
        assert.strictEqual(await pasteInto(top, "document.getElementById('chatInput')"), true);
        await waitFor(async () => (await top("document.querySelectorAll('#chatThumbs img').length")) === 1,
          { timeoutMs: 3000, what: 'the thumbnail under the chat box' });
        await top("document.getElementById('send').click(), 1");
        let got;
        await waitFor(() => { got = store.takeFeedback(key); return got.status === 'feedback'; }, { timeoutMs: 4000, what: 'the chat picture at the agent' });
        assert.deepStrictEqual(got.items.map(i => i.kind), ['chat']);
        assert.deepStrictEqual(fs.readFileSync(got.items[0].images[0]), PNG);
        assert.strictEqual(await top("document.querySelectorAll('#chatThumbs img').length"), 0, 'thumbnail left after send');
      });

      await test('7: on a 390 px phone ten pictures in the chat box keep Send on screen', async () => {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
        await sleep(300);
        // ten different pictures: the same one twice is one attachment
        await top(`(() => {
          const dt = new DataTransfer();
          for (let i = 0; i < 10; i++) {
            const bytes = Uint8Array.from(atob('${PNG_B64}'), c => c.charCodeAt(0));
            dt.items.add(new File([bytes, new Uint8Array([i])], 'shot' + i + '.png', { type: 'image/png' }));
          }
          document.getElementById('chatInput').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          return true;
        })()`);
        await waitFor(async () => (await top("document.querySelectorAll('#chatThumbs img').length")) === 10,
          { timeoutMs: 4000, what: 'ten thumbnails' });
        const m = JSON.parse(await top("JSON.stringify({ b: document.getElementById('send').getBoundingClientRect().bottom, h: innerHeight, sw: document.documentElement.scrollWidth })"));
        assert.ok(m.b <= m.h, `Send ends at ${m.b}px, screen is ${m.h}px`);
        assert.ok(m.sw <= 390, `page is ${m.sw}px wide`);
      });
    } finally {
      cdp.ws.close();
      await closeChrome(child, dir);
    }
  } finally {
    canvas.server.close();
  }
  return finish();
}

function finish() {
  const passed = results.filter(Boolean).length;
  console.log(`\nPassed: ${passed}\nFailed: ${results.length - passed}`);
  return results.length - passed;
}

main().then(failed => process.exit(failed ? 1 : 0), err => { console.error(err); process.exit(1); });
