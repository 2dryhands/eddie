/**
 * The GitHub Pages landing and its playable demo (site/build.js).
 *
 * Gates:
 *   1  the build runs and leaks no local paths or server-only URLs
 *   2  served under a /<repo>/ prefix like Pages, the demo canvas loads the document
 *   3  a real click on the document opens a note; Enter queues it
 *   4  Send puts the note in the chat and the pretend agent answers with its JSON
 *   5  landing and demo fit a 390 px phone without sideways scroll
 *
 * Run with: node tests/site.test.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { SKIP, sleep, waitFor, launchChrome, closeChrome, Cdp, evaluate } = require('./cdp');

const results = [];
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); results.push(true); }
  catch (err) { console.log(`  ✗ ${name}`); console.log(`    Error: ${err.stack || err.message}`); results.push(false); }
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
function serve(root, prefix) { // a stand-in for GitHub Pages: static files under /<repo>/
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (!url.startsWith(prefix)) { res.writeHead(404); return res.end(); }
    let file = path.join(root, url.slice(prefix.length));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const OVERFLOW = `JSON.stringify({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`;

async function main() {
  console.log('\n=== Testing the landing + static demo (site/) ===\n');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'eddie-site-'));

  await test('build runs and leaks no local paths or server-only URLs', () => {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'site', 'build.js'), out], { encoding: 'utf8' });
    const files = walk(out).map(f => path.relative(out, f));
    for (const need of ['index.html', 'demo/index.html', 'demo/client.js', 'demo/sdk.js', 'demo/canvas.css', '.nojekyll']) {
      assert.ok(files.includes(need), `missing ${need}`);
    }
    for (const f of files) {
      const text = fs.readFileSync(path.join(out, f), 'utf8');
      assert.ok(!text.includes(os.homedir()), `${f} leaks the home directory`);
      assert.ok(!/(src|href)="\/(artifact|sdk\.js|client\.js|canvas\.css)/.test(text), `${f} points at a server-root URL`);
    }
  });

  if (SKIP) { console.log(`  ↷ browser gates skipped: ${SKIP}`); return finish(); }

  const prefix = '/eddie/';
  const server = await serve(out, prefix);
  const base = `http://127.0.0.1:${server.address().port}${prefix}`;
  const { child, wsUrl, dir } = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    let frameSession = null;
    cdp.onEvent = msg => {
      if (msg.method !== 'Target.attachedToTarget' || msg.params.targetInfo.type !== 'iframe') return;
      frameSession = msg.params.sessionId;
      cdp.send('Runtime.enable', {}, frameSession).then(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, frameSession)).catch(() => {});
    };
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    const top = expr => evaluate(cdp, sessionId, expr);
    const inFrame = expr => (frameSession ? evaluate(cdp, frameSession, expr) : Promise.resolve(undefined));
    cdp.send('Page.navigate', { url: base + 'demo/' }, sessionId).catch(() => {});

    await test('under a /<repo>/ prefix the demo canvas loads the document', async () => {
      await waitFor(async () => (await top("!!document.getElementById('loadVeil') && !document.getElementById('loadVeil').classList.contains('show')")) === true,
        { timeoutMs: 10000, what: 'pc:ready from the demo document' });
      assert.strictEqual(await inFrame("document.querySelector('h1').textContent"), 'Launch plan: new pricing page');
      assert.strictEqual(await top("getComputedStyle(document.getElementById('rateBar')).display"), 'none', 'in-house rating strip shows in the public demo');
      assert.match(await top("document.querySelector('#presence .label').textContent"), /^(agent listening|агент слушает)$/);
    });

    await test('a real click on the document opens a note; Enter queues it', async () => {
      await top("Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }), 1");
      const at = JSON.parse(await top(`(() => { const r = document.getElementById('artifact').getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y }); })()`));
      const h = JSON.parse(await inFrame(`(() => { const r = document.querySelector('.risk').getBoundingClientRect(); return JSON.stringify({ x: r.x + 20, y: r.y + r.height / 2 }); })()`));
      const x = at.x + h.x, y = at.y + h.y;
      const noteOpen = async () => (await inFrame("document.activeElement && document.activeElement.getAttribute('data-eddie')")) === 'ui';
      await waitFor(async () => { // the SDK may still be wiring its listeners: click until the note box takes focus
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
        await sleep(100);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
        await sleep(300);
        return noteOpen();
      }, { timeoutMs: 6000, intervalMs: 200, what: 'the note box after a click' });
      await cdp.send('Input.insertText', { text: 'Email them a month ahead' }, sessionId);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
      await waitFor(async () => /Email them a month ahead/.test(await top("document.getElementById('queue').textContent")),
        { timeoutMs: 4000, what: 'the note in the queue' });
    });

    await test('Send puts the note in the chat and the agent answers with its JSON', async () => {
      await top("document.getElementById('send').click(), 1");
      await waitFor(async () => {
        const chat = await top("document.getElementById('chatLog').textContent");
        return /Email them a month ahead/.test(chat) && /"kind": "annotation"/.test(chat) && /Got 1|Получил 1/.test(chat);
      }, { timeoutMs: 5000, what: 'the agent reply with JSON' });
      assert.strictEqual(await top("document.getElementById('queue').textContent.includes('Email them')"), false);
    });

    await test('landing and demo fit a 390 px phone without sideways scroll', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
      for (const page of ['', 'demo/']) {
        await cdp.send('Page.navigate', { url: base + page }, sessionId);
        await sleep(1200);
        const m = JSON.parse(await top(OVERFLOW));
        assert.ok(m.sw <= m.cw + 1, `${page || 'landing'}: page is ${m.sw}px wide at 390`);
      }
    });
  } finally {
    cdp.ws.close();
    await closeChrome(child, dir);
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
  return finish();
}

function finish() {
  const passed = results.filter(Boolean).length;
  console.log(`\nPassed: ${passed}\nFailed: ${results.length - passed}`);
  return results.length - passed;
}

main().then(failed => process.exit(failed ? 1 : 0), err => { console.error(err); process.exit(1); });
