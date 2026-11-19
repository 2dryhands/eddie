/**
 * The canvas on a phone, and RU/EN — Eddie in a real Chrome over CDP.
 *
 * The bug (18.11): at 390 px the canvas was 754 px wide — the header buttons
 * and the 340 px side panel sat in one row and pushed the page sideways.
 *
 * Gates:
 *   1  at 390 px nothing sticks out to the right, in both languages
 *   2  at 390 px both the document and the panel get real height
 *   3  a browser asking for Russian gets Russian, English gets English
 *   4  the RU/EN button flips the language and the choice survives a reload
 *   5  desktop (1280 px) keeps the side-by-side layout
 *
 * Run with: node tests/mobile.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSessionStore } = require('../lib/sessions');
const { createPlanCanvasServer } = require('../lib/server');
const { SKIP, waitFor, launchChrome, closeChrome, Cdp, evaluate } = require('./cdp');

const results = [];
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); results.push(true); }
  catch (err) { console.log(`  ✗ ${name}`); console.log(`    Error: ${err.stack || err.message}`); results.push(false); }
}

// Everything in the chrome (not the iframe) whose right edge is past the viewport.
const OVERFLOW = (w = 390) => `JSON.stringify({ sw: document.documentElement.scrollWidth, bad: Array.from(document.querySelectorAll('body *'))
  .filter(el => { const r = el.getBoundingClientRect(); return r.width && r.height && r.right > ${w} + 0.5 && !el.closest('.trail'); })
  .map(el => (el.id || el.className || el.tagName) + ':' + Math.round(el.getBoundingClientRect().right)).slice(0, 8) })`;
const BOX = id => `(() => { const r = document.querySelector('${id}').getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }); })()`;

async function main() {
  console.log('\n=== Testing Eddie on a 390 px phone + RU/EN (real Chrome over CDP) ===\n');
  if (SKIP) { console.log(`  ↷ skipped: ${SKIP}`); console.log('\nPassed: 0\nFailed: 0'); return 0; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eddie-mobile-'));
  const store = createSessionStore({ stateDir: path.join(tmp, 'state') });
  const canvas = createPlanCanvasServer({ store, version: '9.9.9-test', idleTimeoutMs: 0 });
  await canvas.listen(0);
  const port = canvas.server.address().port;
  const file = path.join(tmp, 'a-rather-long-plan-file-name-for-review.md');
  fs.writeFileSync(file, '# Plan\n\nSome text.\n');
  const { key } = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file })
  }).then(r => r.json());
  const url = `http://127.0.0.1:${port}/canvas/${key}`;

  const { child, wsUrl, dir } = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    const ev = expr => evaluate(cdp, sessionId, expr, 3000);
    const json = async expr => JSON.parse(await ev(expr) || 'null');
    async function load({ width, acceptLanguage, clearLang = true }) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: width < 600 }, sessionId);
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 EddieTest', acceptLanguage }, sessionId);
      if (clearLang) await ev("try { localStorage.removeItem('eddie:lang') } catch {}");
      await cdp.send('Page.navigate', { url }, sessionId);
      await waitFor(async () => (await ev("document.readyState === 'complete' && !!document.getElementById('langBtn') && document.getElementById('send').textContent.trim().length > 3")) === true,
        { timeoutMs: 8000, what: 'canvas loaded' });
    }
    const sendLabel = () => ev("document.querySelector('#send [data-i18n]').textContent");

    // First navigation so localStorage belongs to the canvas origin.
    await load({ width: 390, acceptLanguage: 'en-US' });

    await test('3: browser language picks the UI language (ru-RU → RU, en-US → EN)', async () => {
      await load({ width: 390, acceptLanguage: 'ru-RU,ru' });
      assert.strictEqual(await sendLabel(), 'Отправить');
      await load({ width: 390, acceptLanguage: 'en-US,en' });
      assert.strictEqual(await sendLabel(), 'Send');
    });

    for (const lang of ['en-US', 'ru-RU']) {
      await test(`1: nothing wider than 390 px (${lang})`, async () => {
        await load({ width: 390, acceptLanguage: lang });
        await ev("document.getElementById('trail').classList.add('show')");
        const o = await json(OVERFLOW());
        if (process.env.EDDIE_SHOT_DIR) fs.writeFileSync(path.join(process.env.EDDIE_SHOT_DIR, `canvas-390-${lang}.png`),
          Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)).data, 'base64'));
        assert.ok(o.sw <= 390 && o.bad.length === 0, `scrollWidth ${o.sw}, sticking out: ${o.bad.join(', ')}`);
      });
    }

    await test('1b: no overlap or overflow in the header at 721 and 900 px (ru-RU)', async () => {
      for (const w of [721, 900]) {
        await load({ width: w, acceptLanguage: 'ru-RU' });
        const o = await json(OVERFLOW(w));
        assert.ok(o.sw <= w && o.bad.length === 0, `${w}: scrollWidth ${o.sw}, ${o.bad.join(', ')}`);
        const brand = await json(BOX('.brand .name')), btn = await json(BOX('#panelBtn'));
        assert.ok(brand.x + brand.w <= btn.x || brand.y + brand.h <= btn.y, `${w}: brand under the panel button`);
      }
      await load({ width: 390, acceptLanguage: 'ru-RU' });
    });

    await test('2: at 390 px the document and the panel both get real room', async () => {
      const frame = await json(BOX('.frame')), panel = await json(BOX('.panel'));
      assert.ok(frame.w >= 380 && frame.h >= 250, `frame ${JSON.stringify(frame)}`);
      assert.ok(panel.w >= 380 && panel.h >= 200, `panel ${JSON.stringify(panel)}`);
      assert.ok(panel.y >= frame.y + frame.h - 1, 'panel sits under the document');
    });

    await test('4: RU/EN button flips the language and it sticks after reload', async () => {
      await load({ width: 390, acceptLanguage: 'en-US' });
      assert.strictEqual(await sendLabel(), 'Send');
      await ev("document.getElementById('langBtn').click()");
      assert.strictEqual(await sendLabel(), 'Отправить');
      assert.strictEqual(await ev("document.getElementById('langBtn').textContent"), 'EN');
      await load({ width: 390, acceptLanguage: 'en-US', clearLang: false });
      assert.strictEqual(await sendLabel(), 'Отправить');
    });

    await test('5: desktop 1280 px keeps the panel beside the document', async () => {
      await load({ width: 1280, acceptLanguage: 'en-US' });
      const frame = await json(BOX('.frame')), panel = await json(BOX('.panel'));
      assert.strictEqual(Math.round(panel.w), 340);
      assert.ok(Math.abs(panel.y - frame.y) < 1 && panel.x >= frame.x + frame.w - 1, 'side by side');
      const o = await json(OVERFLOW(1280));
      assert.ok(o.bad.length === 0, o.bad.join(', '));
    });
  } finally {
    await closeChrome(child, dir);
    await canvas.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const passed = results.filter(Boolean).length, failed = results.length - passed;
  console.log(`\nPassed: ${passed}\nFailed: ${failed}`);
  return failed ? 1 : 0;
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(1); });
