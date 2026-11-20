/**
 * The agent asks a question with ready answers; the human clicks one; the
 * agent's await gets the choice as JSON.
 *
 * Gates:
 *   1  `await --ask "Q" --option A --option B` puts the question with its
 *      buttons into the canvas chat (kind "ask", options, askId)
 *   2  --ask with fewer than 2 or more than 6 options, or an empty one, is
 *      refused before anything is posted (CLI exits non-zero, HTTP 400)
 *   3  an answer comes back as { kind: "answer", question, answer, index, askId };
 *      it is not a task; the chat shows who chose what
 *   4  the same question answered twice, an unknown askId, a bad index → dropped
 *   5  real Chrome: click the second button → the agent gets index 1 as JSON;
 *      the buttons lock and mark the choice; on 390 px no sideways scroll
 *
 * Run with: node tests/ask.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

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

const CLI = path.join(__dirname, '..', 'eddie.js');

async function main() {
  console.log('\n=== Testing agent questions with ready answers ===\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eddie-ask-'));
  const stateDir = path.join(tmp, 'state');
  const store = createSessionStore({ stateDir });
  const canvas = createPlanCanvasServer({ store, version: '9.9.9-test', idleTimeoutMs: 0 });
  await canvas.listen(0);
  const port = canvas.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const file = path.join(tmp, 'plan.html');
  fs.writeFileSync(file, '<!DOCTYPE html><html><body><h1>Plan</h1></body></html>');
  const { key } = await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file })
  }).then(r => r.json());
  // Async: the server runs in this process, a sync spawn would freeze it.
  const cli = args => new Promise(resolve => execFile(process.execPath, [CLI, 'await', file, '--timeout-ms', '1', ...args],
    { encoding: 'utf8', timeout: 15000, env: { ...process.env, EDDIE_PORT: String(port), EDDIE_STATE_DIR: stateDir } },
    (err, stdout, stderr) => resolve({ status: err ? (err.code || 1) : 0, stdout, stderr })));
  const feedback = items => fetch(`${base}/api/session/${key}/feedback`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items })
  }).then(r => r.json());
  const lastAsk = () => store.get(key).chat.filter(m => m.kind === 'ask').slice(-1)[0];

  try {
    await test('1: --ask with --option puts the question and its buttons into the chat', async () => {
      const r = await cli(['--ask', 'Which layout?', '--option', 'Cards', '--option', 'Table', '--option', 'Both']);
      assert.strictEqual(r.status, 0, r.stderr);
      const ask = lastAsk();
      assert.ok(ask, 'no ask entry in the chat');
      assert.strictEqual(ask.role, 'agent');
      assert.strictEqual(ask.text, 'Which layout?');
      assert.deepStrictEqual(ask.options, ['Cards', 'Table', 'Both']);
      assert.match(ask.askId, /^ask-\d+$/);
    });

    await test('2: one option, seven options or an empty one are refused', async () => {
      const before = store.get(key).chat.length;
      for (const opts of [['A'], ['1', '2', '3', '4', '5', '6', '7'], ['A', '  ']]) {
        const r = await cli(['--ask', 'Q?', ...opts.flatMap(o => ['--option', o])]);
        assert.notStrictEqual(r.status, 0, `CLI accepted ${JSON.stringify(opts)}`);
        const res = await fetch(`${base}/api/session/${key}/reply`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Q?', options: opts })
        });
        assert.strictEqual(res.status, 400, `server accepted ${JSON.stringify(opts)}`);
      }
      assert.strictEqual((await cli(['--option', 'A', '--option', 'B'])).status === 0, false, '--option without --ask accepted');
      assert.strictEqual(store.get(key).chat.length, before, 'a refused question reached the chat');
    });

    await test('3: the answer reaches the agent as JSON, is not a task, shows in the chat', async () => {
      const ask = lastAsk();
      const r = await feedback([{ kind: 'answer', askId: ask.askId, index: 1 }]);
      assert.strictEqual(r.accepted, 1);
      const got = store.takeFeedback(key);
      assert.strictEqual(got.status, 'feedback');
      const { id, at, ...item } = got.items[0];
      assert.deepStrictEqual(item, { kind: 'answer', text: 'Table', question: 'Which layout?', answer: 'Table', index: 1, askId: ask.askId });
      assert.ok(!store.get(key).tasks.some(t => t.kind === 'answer'), 'the answer became a task');
      assert.strictEqual(lastAsk().answered, 1);
      const line = store.get(key).chat.slice(-1)[0];
      assert.strictEqual(line.role, 'user');
      assert.strictEqual(line.kind, 'answer');
      assert.match(line.text, /Table/);
    });

    await test('4: a second answer, an unknown question, a bad index are dropped', async () => {
      const ask = lastAsk();
      const r = await feedback([
        { kind: 'answer', askId: ask.askId, index: 0 },
        { kind: 'answer', askId: 'ask-999999', index: 0 },
        { kind: 'answer', askId: ask.askId, index: 7 },
        { kind: 'answer', askId: ask.askId, index: '1' }
      ]);
      assert.strictEqual(r.accepted, 0);
      assert.strictEqual(store.takeFeedback(key).status, 'waiting');
      assert.strictEqual(lastAsk().answered, 1, 'a second answer overwrote the first');
    });

    if (SKIP) {
      console.log(`  ↷ browser gate skipped: ${SKIP}`);
      return finish();
    }

    const r = await cli(['--ask', 'Ship on Friday?', '--option', 'Yes, ship', '--option', 'Wait till Monday']);
    assert.strictEqual(r.status, 0, r.stderr);
    const { child, wsUrl, dir } = await launchChrome();
    const cdp = await Cdp.connect(wsUrl);
    try {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
      await cdp.send('Page.navigate', { url: `${base}/canvas/${key}` }, sessionId);
      const top = expr => evaluate(cdp, sessionId, expr);
      const btns = "[...document.querySelectorAll('#chatLog .msg.kind-ask')].pop().querySelectorAll('.ask-opt')";

      await test('5: a click on the second button reaches the agent as index 1; buttons lock', async () => {
        await waitFor(async () => (await top(`${btns}.length`)) === 2, { timeoutMs: 10000, what: 'two answer buttons' });
        const seen = JSON.parse(await top(`JSON.stringify((() => { const q = [...document.querySelectorAll('#chatLog .msg.kind-ask')].pop().getBoundingClientRect(), log = document.getElementById('chatLog').getBoundingClientRect(); return { q: q.top, log: log.top }; })())`));
        assert.ok(seen.q >= seen.log - 1, `the open question starts above the chat window (${seen.q} < ${seen.log})`);
        const sw = await top('document.documentElement.scrollWidth');
        assert.ok(sw <= 390, `page is ${sw}px wide on a phone`);
        await top(`${btns}[1].click(), 1`);
        let got;
        await waitFor(() => { got = store.takeFeedback(key); return got.status === 'feedback'; }, { timeoutMs: 4000, what: 'the answer at the agent' });
        assert.strictEqual(got.items.length, 1, JSON.stringify(got));
        assert.strictEqual(got.items[0].kind, 'answer');
        assert.strictEqual(got.items[0].index, 1);
        assert.strictEqual(got.items[0].answer, 'Wait till Monday');
        assert.strictEqual(got.items[0].question, 'Ship on Friday?');
        await waitFor(async () => (await top(`${btns}.length === 2 && [...${btns}].every(b => b.disabled)`)) === true, { timeoutMs: 4000, what: 'locked buttons' });
        assert.strictEqual(await top(`${btns}[1].classList.contains('chosen')`), true, 'the choice is not marked');
        await sleep(100);
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
  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
