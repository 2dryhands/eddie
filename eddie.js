#!/usr/bin/env node
'use strict';

/**
 * Eddie CLI — open plan artifacts in a browser review canvas and block
 * on human feedback.
 *
 *   node eddie.js open .claude/plans/feature.plan.md
 *   node eddie.js await .claude/plans/feature.plan.md
 *   node eddie.js await <file> --reply "Updated section 3."
 *   node eddie.js end <file>
 *   node eddie.js stop
 *
 * Agents: `open` returns immediately (the server is a detached process);
 * `await` long-polls until the human sends feedback, a verdict, or ends the
 * session, then prints a JSON payload to stdout. Progress notes go to stderr
 * so stdout stays parseable.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const {
  askOptionsProblem,
  canonicalizeArtifactPath,
  createSessionStore,
  resolveStateDir,
  sessionKeyFor
} = require('./lib/sessions');
const {
  DEFAULT_HOST,
  createPlanCanvasServer,
  resolveIdleTimeoutMs,
  resolveMaxStreams,
  resolvePort
} = require('./lib/server');

const VERSION = require('./package.json').version;

function usage() {
  return [
    'Eddie - review plans and HTML artifacts in the browser',
    '',
    'Usage:',
    '  node eddie.js                      Show server status and sessions',
    '  node eddie.js open <file>          Open (or resume) a review session',
    '  node eddie.js await <file>         Block until the human sends feedback',
    '  node eddie.js end <file>           End a session as the agent',
    '  node eddie.js stop                 Shut down the canvas server',
    '  node eddie.js plan-hook            Claude Code ExitPlanMode hook (reads hook JSON on stdin)',
    '  node eddie.js server               Run the server in the foreground',
    '',
    'Options:',
    '  open:  --no-open      Do not launch a browser window',
    '         --reopen       Reopen a session the user ended from the browser',
    '         --new-tab      Launch a new tab even if one already shows the page',
    '  await: --reply <msg>  Show an agent reply in the canvas chat before waiting',
    '         --resolve <id>:<status>:<note>   Mark a task done|answered|declined (repeatable)',
    '         --ask <question> --option <a> --option <b>   Ask with 2-6 answer buttons; the click comes back as kind "answer"',
    '         --timeout-ms <n>  Return {status:"waiting"} after n ms (tests/debug only)',
    '  server: --port <n> --host <h>',
    '',
    'Environment: EDDIE_PORT, EDDIE_STATE_DIR, EDDIE_IDLE_MS, EDDIE_MAX_STREAMS, EDDIE_PLAN_REVIEW=off'
  ].join('\n');
}

// Flags that take a value: their value is never the file argument.
const VALUE_FLAGS = new Set(['--reply', '--ask', '--option', '--resolve', '--timeout-ms', '--port', '--host']);

// The file is the first non-flag argument, so `open --no-open plan.md` works too.
function fileArg(args) {
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) i++;
    else if (!args[i].startsWith('--')) return args[i];
  }
  return undefined;
}

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function serverInfoPath(stateDir) {
  return path.join(stateDir, 'server.json');
}

function readServerInfo(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(serverInfoPath(stateDir), 'utf8'));
  } catch {
    return null;
  }
}

function request(port, method, requestPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: DEFAULT_HOST,
        port,
        method,
        path: requestPath,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {}
      },
      res => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(data.trim() || '{}') });
          } catch {
            resolve({ statusCode: res.statusCode, body: {} });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function healthCheck(port) {
  try {
    const res = await request(port, 'GET', '/health');
    return res.body && res.body.app === 'eddie' ? res.body : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Start (or reuse) the detached canvas server and return its port. A version
// mismatch after an Eddie update restarts the server so browser and CLI never
// disagree about the protocol.
async function ensureServer({ stateDir, port }) {
  const health = await healthCheck(port);
  if (health && health.version === VERSION) return port;
  if (health) {
    await request(port, 'POST', '/shutdown').catch(() => {});
    for (let i = 0; i < 20 && (await healthCheck(port)); i++) await sleep(100);
  }
  fs.mkdirSync(stateDir, { recursive: true });
  const logFd = fs.openSync(path.join(stateDir, 'server.log'), 'a');
  const child = spawn(process.execPath, [__filename, 'server', '--port', String(port)], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, EDDIE_STATE_DIR: stateDir }
  });
  child.unref();
  fs.closeSync(logFd);
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (await healthCheck(port)) return port;
  }
  throw new Error(`eddie server did not become healthy on port ${port}; check ${path.join(stateDir, 'server.log')}`);
}

// macOS-only: Chrome's Blink parses a heavy sandboxed iframe (data-URI
// fonts/images, dozens of charts) far faster than Safari's WebKit, which can
// stall many seconds on the same artifact or wedge the iframe permanently
// blank — see the readiness-watchdog comments in lib/ui.js and fix commits
// b6825ca/be8653c/cb878c9, three rounds of patching the *symptom* on the
// canvas side. Routing around WebKit for the initial launch fixes the cause
// instead: skip it whenever Chrome is actually installed, otherwise fall
// through to the system default untouched.
const CHROME_APP_PATH = '/Applications/Google Chrome.app';

function openBrowser(url) {
  const platform = process.platform;
  if (platform === 'darwin' && fs.existsSync(CHROME_APP_PATH)) {
    try {
      spawn('open', ['-a', 'Google Chrome', url], { detached: true, stdio: 'ignore' }).unref();
      return true;
    } catch {
      // fall through to the system default below
    }
  }
  const [cmd, args] =
    platform === 'darwin' ? ['open', [url]]
      : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

// The server thinks a tab shows this page: bring it to the front instead of
// launching a duplicate. True = fronted (or no way to check off macOS+Chrome:
// trust the server); false = Chrome has no such tab, no Automation permission,
// or it hung — the caller launches a fresh tab, so nobody is left staring at nothing.
function focusTab(url) {
  if (process.platform !== 'darwin' || !fs.existsSync(CHROME_APP_PATH)) return true;
  const script = `if application "Google Chrome" is running then
  tell application "Google Chrome"
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        if URL of t starts with "${url}" then
          set active tab index of w to i
          set minimized of w to false
          set index of w to 1
          activate
          return "found"
        end if
      end repeat
    end repeat
  end tell
end if
return "missing"`;
  const res = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 3000 });
  return res.status === 0 && res.stdout.trim() === 'found';
}

function output(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function cmdStatus({ stateDir, port }) {
  const health = await healthCheck(port);
  if (!health) {
    return { server: 'not running', hint: 'open an artifact to start one', stateDir };
  }
  const sessions = await request(port, 'GET', '/api/sessions');
  return { server: `http://${DEFAULT_HOST}:${port}`, version: health.version, sessions: sessions.body.sessions };
}

async function cmdOpen(file, args, { stateDir, port }, browser = { launch: openBrowser, focus: focusTab }) {
  if (!file) throw new Error('open requires a file path');
  if (!fs.existsSync(path.resolve(file))) throw new Error(`artifact not found: ${file}`);
  await ensureServer({ stateDir, port });
  const res = await request(port, 'POST', '/api/sessions', {
    file: path.resolve(file),
    reopen: args.includes('--reopen')
  });
  if (res.statusCode === 409) return res.body;
  if (res.statusCode !== 200) throw new Error(res.body.error || `open failed (HTTP ${res.statusCode})`);
  const url = `http://${DEFAULT_HOST}:${port}${res.body.url}`;
  const noOpen = args.includes('--no-open');
  // --reopen keeps launching: the old tab still wears the "handed off" overlay.
  const reuse = !noOpen && res.body.liveTab && !args.includes('--new-tab') && !args.includes('--reopen')
    && browser.focus(url);
  const launched = noOpen || reuse ? false : browser.launch(url);
  return {
    status: 'open',
    url,
    browser: reuse ? 'already open' : launched ? 'opened' : 'not opened',
    ...(res.body.note ? { note: res.body.note } : {}),
    next_step:
      'Run `eddie await <file>` and leave it running; it returns when the human sends feedback, a verdict, or ends the session.'
  };
}

function awaitRequest(port, file, timeoutMs) {
  const params = new URLSearchParams({ file });
  if (timeoutMs !== null) params.set('timeoutMs', String(timeoutMs));
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: DEFAULT_HOST, port, method: 'GET', path: `/api/await?${params}` },
      res => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data.trim()));
          } catch {
            reject(new Error('await response was not JSON (server restarted?) - re-run await; feedback is never lost'));
          }
        });
      }
    );
    req.setTimeout(0);
    req.on('error', reject);
    req.end();
  });
}

// Parse repeatable `--resolve "<id>:<status>:<note>"` flags. The note is the
// greedy tail, so it may itself contain colons; malformed values are warned
// about (stderr by default) and skipped rather than aborting the await.
function parseResolveArgs(args, warn = msg => process.stderr.write(msg)) {
  const resolutions = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--resolve' || !args[i + 1]) continue;
    const m = /^([^:]+):(done|answered|declined):([\s\S]*)$/.exec(args[i + 1]);
    if (m) resolutions.push({ id: m[1], status: m[2], note: m[3] });
    else warn(`[eddie] bad --resolve "${args[i + 1]}", expected id:status:note (status: done|answered|declined)\n`);
  }
  return resolutions;
}

async function cmdAwait(file, args, { stateDir, port }) {
  if (!file) throw new Error('await requires a file path');
  if (!(await healthCheck(port))) {
    return { status: 'no-server', hint: 'no canvas server is running; use `open` first', stateDir };
  }
  // Checked before anything is posted: a bad question must not half-reach the canvas.
  const ask = valueAfter(args, '--ask');
  const options = args.flatMap((a, i) => (a === '--option' && i + 1 < args.length ? [args[i + 1]] : []));
  if (ask !== null || options.length) {
    if (!ask || !ask.trim()) throw new Error('--option needs --ask "<question>"');
    const problem = askOptionsProblem(options);
    if (problem) throw new Error(`--ask: ${problem}`);
  }
  const reply = valueAfter(args, '--reply');
  if (reply) {
    const key = sessionKeyFor(canonicalizeArtifactPath(file));
    const res = await request(port, 'POST', `/api/session/${key}/reply`, { text: reply });
    if (res.statusCode !== 200) {
      process.stderr.write(
        `[eddie] --reply failed (HTTP ${res.statusCode}): ${res.body.error || 'unknown error'} — the reply did not reach the canvas; the await below still runs\n`
      );
    }
  }
  if (ask) {
    const key = sessionKeyFor(canonicalizeArtifactPath(file));
    const res = await request(port, 'POST', `/api/session/${key}/reply`, { text: ask, options });
    if (res.statusCode !== 200) throw new Error(`--ask failed (HTTP ${res.statusCode}): ${res.body.error || 'unknown error'}`);
  }
  const resolutions = parseResolveArgs(args);
  if (resolutions.length) {
    const key = sessionKeyFor(canonicalizeArtifactPath(file));
    const res = await request(port, 'POST', `/api/session/${key}/resolve`, { resolutions });
    if (res.statusCode !== 200) {
      process.stderr.write(
        `[eddie] --resolve failed (HTTP ${res.statusCode}): ${res.body.error || 'unknown error'} — tasks may still show unresolved; the await below still runs\n`
      );
    } else if ((res.body.updated || 0) < resolutions.length) {
      process.stderr.write(
        `[eddie] --resolve only updated ${res.body.updated || 0} of ${resolutions.length} task(s) — check the ids match ones from a previous await\n`
      );
    }
  }
  const timeoutRaw = valueAfter(args, '--timeout-ms');
  const timeoutMs = timeoutRaw === null ? null : Number.parseInt(timeoutRaw, 10) || 0;
  process.stderr.write('[eddie] waiting for human feedback... leave this running (re-run if interrupted; queued feedback is never lost)\n');
  const result = await awaitRequest(port, path.resolve(file), timeoutMs);
  if (result.status === 'feedback') {
    result.next_step = result.sessionEnded
      ? 'The user sent this feedback and ended the session. Address it and report in chat; do not reopen the canvas uninvited.'
      : 'Address the feedback, then run `eddie await <file> --reply "<what you changed>"` to answer in the canvas and keep listening.';
  } else if (result.status === 'ended') {
    result.next_step =
      result.endedBy === 'user'
        ? 'The user ended this review. Stop polling and deliver any remaining updates in chat; do not reopen uninvited.'
        : 'Session ended. Stop polling.';
  }
  return result;
}

// Claude Code PermissionRequest hook on ExitPlanMode (hooks/hooks.json): the
// plan opens in the canvas and the human's verdict answers the approval step.
// Returns null — print nothing — whenever the canvas can't answer (switched
// off, bad input, review closed, server gone): Claude Code then shows its own
// terminal prompt, so the human is never left without a way to reply.
async function cmdPlanHook(args, context, stdin) {
  if (process.env.EDDIE_PLAN_REVIEW === 'off') return null;
  let input;
  try {
    input = JSON.parse(stdin);
  } catch {
    return null;
  }
  const toolInput = (input && input.tool_input) || {};
  let file = toolInput.planFilePath;
  if (!file || !fs.existsSync(file)) {
    if (typeof toolInput.plan !== 'string' || !toolInput.plan.trim()) return null;
    const dir = path.join(context.stateDir, 'plans');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${String(input.session_id || 'plan').replace(/[^\w-]/g, '_')}.md`);
    fs.writeFileSync(file, toolInput.plan);
  }
  // A verdict clicked before this call saw an older version of the plan: it
  // must not approve this one. Notes from then are still delivered.
  const since = Date.now();
  const opened = await cmdOpen(file, args, context);
  if (opened.status !== 'open') return null;
  // No canvas tab for two checks in a row (closed, or the browser never
  // opened): give the question back to the terminal instead of hanging.
  const graceMs = Number.parseInt(process.env.EDDIE_PLAN_TAB_GRACE_MS, 10) || 30000;
  let tablessChecks = 0;
  for (;;) {
    const result = await awaitRequest(context.port, path.resolve(file), graceMs);
    if (result.status === 'waiting') {
      const list = await request(context.port, 'GET', '/api/sessions');
      const me = (list.body.sessions || []).find(x => x.file === opened.file || x.key === opened.url.split('/canvas/')[1]);
      tablessChecks = me && me.liveTab ? 0 : tablessChecks + 1;
      if (tablessChecks >= 2) return null;
      continue;
    }
    if (result.status !== 'feedback') return null;
    const approved = result.items.some(i => i.kind === 'verdict' && i.verdict === 'approve' && Date.parse(i.at) >= since);
    const changes = result.items.some(i => i.kind === 'verdict' && i.verdict === 'request-changes' && Date.parse(i.at) >= since);
    const notes = result.items.filter(i => i.kind !== 'verdict' && i.kind !== 'rating' && !i.silent);
    let decision;
    if (approved) {
      let plan = fs.readFileSync(file, 'utf8');
      if (notes.length) plan += `\n\n## Reviewer notes\n\n${notes.map(n => `- ${noteLine(n)}`).join('\n')}\n`;
      decision = { behavior: 'allow', updatedInput: { ...toolInput, plan } };
    } else if (notes.length || changes) {
      decision = {
        behavior: 'deny',
        message: 'The human reviewed the plan in the Eddie canvas and asked for changes. Revise the plan file to address ' +
          `every item below, then call ExitPlanMode again (the canvas reloads by itself).\n${JSON.stringify(notes, null, 2)}`
      };
    } else {
      continue; // only a rating: nothing to act on, keep waiting
    }
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
}

function noteLine(item) {
  const where = item.anchor && item.anchor.snippet ? ` (on "${item.anchor.snippet}")` : '';
  const edit = item.edit ? ` ${JSON.stringify(item.edit)}` : '';
  return `${item.text || ''}${edit}${where}`.trim();
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function cmdEnd(file, { port }) {
  if (!file) throw new Error('end requires a file path');
  if (!(await healthCheck(port))) return { status: 'no-server' };
  const res = await request(port, 'POST', '/api/end', { file: path.resolve(file) });
  return res.body;
}

async function cmdStop({ stateDir, port }) {
  if (!(await healthCheck(port))) return { status: 'not running' };
  await request(port, 'POST', '/shutdown').catch(() => {});
  fs.rmSync(serverInfoPath(stateDir), { force: true });
  return { status: 'stopping' };
}

async function cmdServer(args, { stateDir, port }) {
  const portArg = valueAfter(args, '--port');
  const hostArg = valueAfter(args, '--host');
  const listenPort = portArg !== null ? Number.parseInt(portArg, 10) : port;
  const store = createSessionStore({ stateDir });
  let shuttingDown = false;
  const shutdown = async code => {
    if (shuttingDown) return;
    shuttingDown = true;
    fs.rmSync(serverInfoPath(stateDir), { force: true });
    await canvas.close().catch(() => {});
    process.exit(code);
  };
  const canvas = createPlanCanvasServer({
    store,
    host: hostArg || DEFAULT_HOST,
    version: VERSION,
    idleTimeoutMs: resolveIdleTimeoutMs(),
    maxStreams: resolveMaxStreams(),
    courierFile: path.join(stateDir, 'courier'),
    onIdleShutdown: () => shutdown(0),
    log: line => process.stderr.write(`${line}\n`)
  });
  const bound = await canvas.listen(listenPort);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    serverInfoPath(stateDir),
    JSON.stringify({ pid: process.pid, port: bound.port, version: VERSION, startedAt: new Date().toISOString() }, null, 2)
  );
  // Sessions restored from disk resume their file watchers.
  for (const session of store.list()) {
    if (session.status !== 'ended') canvas.watchSession(store.get(session.key));
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.stderr.write(`[eddie] serving on http://${bound.host}:${bound.port}\n`);
  return new Promise(() => {}); // run until a signal or idle shutdown
}

async function main(argv = process.argv.slice(2)) {
  const args = argv.slice();
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : null;
  const stateDir = resolveStateDir();
  // A running server may sit on a non-default port; trust its recorded info.
  const recorded = readServerInfo(stateDir);
  const context = { stateDir, port: (recorded && recorded.port) || resolvePort() };
  if (command === 'plan-hook') {
    // A hook must never print anything but its decision: errors stay silent.
    const decision = await cmdPlanHook(args, context, await readStdin()).catch(() => null);
    if (decision) output(decision);
    return 0;
  }
  try {
    if (command === null) output(await cmdStatus(context));
    else if (command === 'open') output(await cmdOpen(fileArg(args), args, context));
    else if (command === 'await') output(await cmdAwait(fileArg(args), args, context));
    else if (command === 'end') output(await cmdEnd(fileArg(args), context));
    else if (command === 'stop') output(await cmdStop(context));
    else if (command === 'server') await cmdServer(args, context);
    else {
      process.stderr.write(`Unknown command: ${command}\n\n${usage()}\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    output({ error: error.message });
    return 1;
  }
}

if (require.main === module) {
  main().then(code => {
    process.exitCode = code;
  });
}

module.exports = { main, cmdOpen, ensureServer, healthCheck, parseResolveArgs };
