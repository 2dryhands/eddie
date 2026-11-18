'use strict';
/**
 * Minimal Chrome DevTools Protocol driver for the browser tests: headless
 * Chrome over Node's built-in WebSocket, no automation dependency.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CHROME = process.env.EDDIE_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Why the browser tests can't run here, or null. CDP talks over Node's global
// WebSocket, which ships unflagged only from Node 22.
const SKIP = !fs.existsSync(CHROME) ? `no Chrome at ${CHROME} (set EDDIE_TEST_CHROME)`
  : typeof WebSocket === 'undefined' ? `no built-in WebSocket in Node ${process.version} (needs 22+)`
    : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50, what = 'condition' } = {}) {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return Date.now() - startedAt;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${what} (${timeoutMs}ms)`);
    await sleep(intervalMs);
  }
}



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
    // Ubuntu 23.10+ blocks Chrome's user-namespace sandbox for unprivileged users (CI runners).
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
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
    this.events = [];            // protocol events ({method, params, sessionId}), for tests that watch the console
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.method) { this.events.push(msg); if (this.onEvent) this.onEvent(msg); return; }
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

module.exports = { CHROME, SKIP, sleep, waitFor, launchChrome, Cdp, evaluate };
