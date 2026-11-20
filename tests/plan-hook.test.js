'use strict';
// Plan mode → canvas: the Claude Code PermissionRequest hook on ExitPlanMode
// (`eddie.js plan-hook`) opens the plan and answers the approval step with the
// human's verdict. Real CLI + real detached server; the browser is simulated
// over the same HTTP surface the canvas uses.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { canonicalizeArtifactPath, sessionKeyFor } = require('../lib/sessions');

const CLI = path.join(__dirname, '..', 'eddie.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eddie-planhook-'));
const stateDir = path.join(tmp, 'state');
const port = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, EDDIE_STATE_DIR: stateDir, EDDIE_PORT: String(port) };

let failed = false;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed = true; console.log(`  ✗ ${name}\n    ${err.stack}`); }
}

function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(data);
  });
}

function sessionOpen(key) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/sessions', agent: false }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(JSON.parse(data).sessions.some(x => x.key === key && x.status === 'open')));
    }).on('error', reject);
  });
}

// Run the hook with the given stdin; `browser` acts once the session exists.
function runHook(input, browser, extraEnv = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, 'plan-hook', '--no-open'], { env: { ...env, ...extraEnv } });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.on('close', code => resolve({ code, out: out.trim(), json: out.trim() ? JSON.parse(out) : null }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    if (browser) {
      const file = input.tool_input.planFilePath || path.join(stateDir, 'plans', `${input.session_id}.md`);
      // The session exists once the hook has opened it: retry until the browser call lands.
      const poll = setInterval(async () => {
        if (busy) return;
        busy = true;
        const key = sessionKeyFor(canonicalizeArtifactPath(file)); // realpath only once the hook wrote the file
        const open = await sessionOpen(key).catch(() => false);
        const status = open ? await browser(key).catch(() => 0) : 0;
        if (status === 200) clearInterval(poll);
        busy = false;
      }, 150);
      let busy = false;
    }
  });
}

const planFile = path.join(tmp, 'plans', 'auth.md');
fs.mkdirSync(path.dirname(planFile), { recursive: true });
fs.writeFileSync(planFile, '# Plan: auth\n\n1. Extract token check\n2. Add tests\n');
const hookInput = (extra = {}) => ({
  session_id: 'sess-1', hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode',
  tool_input: { plan: fs.readFileSync(planFile, 'utf8'), planFilePath: planFile, ...extra }
});

setTimeout(() => { console.log('  ✗ timed out'); process.exit(1); }, 60000).unref();
(async () => {
  console.log('\n=== plan mode hook ===\n');
  try {
    await test('switched off: no output, no server', async () => {
      const r = await runHook(hookInput(), null, { EDDIE_PLAN_REVIEW: 'off' });
      assert.strictEqual(r.code, 0);
      assert.strictEqual(r.out, '');
      assert.ok(!fs.existsSync(path.join(stateDir, 'server.json')));
    });

    await test('bad stdin: no output, exit 0 (terminal prompt takes over)', async () => {
      const r = await runHook('not json', null);
      assert.strictEqual(r.code, 0);
      assert.strictEqual(r.out, '');
    });

    await test('annotation + request changes → deny with the note in message', async () => {
      const r = await runHook(hookInput(), key => post(`/api/session/${key}/feedback`, { items: [
        { kind: 'annotation', text: 'Split step 2 into unit and e2e', anchor: { selector: 'li:nth-of-type(2)', tag: 'li', snippet: 'Add tests' } },
        { kind: 'verdict', verdict: 'request-changes' }
      ] }));
      assert.strictEqual(r.code, 0);
      const d = r.json.hookSpecificOutput;
      assert.strictEqual(d.hookEventName, 'PermissionRequest');
      assert.strictEqual(d.decision.behavior, 'deny');
      assert.ok(d.decision.message.includes('Split step 2 into unit and e2e'));
      assert.ok(d.decision.message.includes('ExitPlanMode'));
    });

    await test('revised plan, approve → allow with the plan from disk in updatedInput', async () => {
      fs.appendFileSync(planFile, '3. Unit tests\n4. E2E tests\n');
      const r = await runHook(hookInput(), key => post(`/api/session/${key}/feedback`, {
        items: [{ kind: 'verdict', verdict: 'approve' }] }));
      const d = r.json.hookSpecificOutput.decision;
      assert.strictEqual(d.behavior, 'allow');
      assert.strictEqual(d.updatedInput.planFilePath, planFile);
      assert.ok(d.updatedInput.plan.includes('4. E2E tests'));
      assert.ok(!d.updatedInput.plan.includes('Reviewer notes'));
    });

    await test('approve with a note → allow, note appended to the plan', async () => {
      const r = await runHook(hookInput(), key => post(`/api/session/${key}/feedback`, { items: [
        { kind: 'chat', text: 'Keep the old endpoint for a week' }, { kind: 'verdict', verdict: 'approve' }] }));
      const d = r.json.hookSpecificOutput.decision;
      assert.strictEqual(d.behavior, 'allow');
      assert.ok(/Reviewer notes[\s\S]*Keep the old endpoint for a week/.test(d.updatedInput.plan));
    });

    await test('verdict clicked before the revision does not approve it; notes still arrive', async () => {
      const r1 = await runHook(hookInput(), async key => {
        const st = await post(`/api/session/${key}/feedback`, { items: [{ kind: 'chat', text: 'Rename step 1' }] });
        await new Promise(res => setTimeout(res, 100));
        await post(`/api/session/${key}/feedback`, { items: [{ kind: 'verdict', verdict: 'approve' }] });
        return st;
      });
      assert.strictEqual(r1.json.hookSpecificOutput.decision.behavior, 'deny');
      await new Promise(res => setTimeout(res, 400)); // the late approve lands while no hook is waiting
      fs.appendFileSync(planFile, '5. Step the human has not seen\n');
      const started = Date.now();
      const r2 = await runHook(hookInput(), async key => {
        await new Promise(res => setTimeout(res, 1000)); // the stale approve must not settle it meanwhile
        return post(`/api/session/${key}/feedback`, { items: [{ kind: 'verdict', verdict: 'approve' }] });
      });
      assert.ok(Date.now() - started >= 1000, 'second round waited for a fresh verdict');
      assert.strictEqual(r2.json.hookSpecificOutput.decision.behavior, 'allow');
    });

    await test('no canvas tab (closed or never opened) → hook gives up, no output', async () => {
      const r = await runHook(hookInput(), null, { EDDIE_PLAN_TAB_GRACE_MS: '300' });
      assert.strictEqual(r.code, 0);
      assert.strictEqual(r.out, '');
    });

    await test('human closes the review → no output (terminal prompt takes over)', async () => {
      const r = await runHook(hookInput(), key => post(`/api/session/${key}/end`, {}));
      assert.strictEqual(r.code, 0);
      assert.strictEqual(r.out, '');
    });

    await test('no planFilePath → plan written under state/plans and reviewed there', async () => {
      const input = { session_id: 'sess_2', tool_name: 'ExitPlanMode', tool_input: { plan: '# Inline plan\n' } };
      const r = await runHook(input, key => post(`/api/session/${key}/feedback`, {
        items: [{ kind: 'verdict', verdict: 'approve' }] }));
      assert.strictEqual(r.json.hookSpecificOutput.decision.behavior, 'allow');
      assert.ok(fs.existsSync(path.join(stateDir, 'plans', 'sess_2.md')));
    });
  } finally {
    spawnSync(process.execPath, [CLI, 'stop'], { env });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})();
