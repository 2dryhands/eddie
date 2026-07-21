/**
 * Tests for lib/sessions.js
 *
 * Run with: node tests/sessions.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  canonicalizeArtifactPath,
  chatLineFor,
  createSessionStore,
  normalizeFeedbackItem,
  sessionKeyFor
} = require('../lib/sessions');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eddie-sessions-test-'));
  const artifact = path.join(dir, 'demo.plan.md');
  fs.writeFileSync(artifact, '# Plan\n');
  const store = createSessionStore({ stateDir: path.join(dir, 'state') });
  return { dir, artifact, store };
}

function runTests() {
  console.log('\n=== Testing eddie sessions.js ===\n');

  let passed = 0;
  let failed = 0;
  const fixtures = [];

  console.log('Keys and normalization:');

  if (test('sessionKeyFor is a stable 12-char hex key', () => {
    const key = sessionKeyFor('/tmp/x.md');
    assert.match(key, /^[a-f0-9]{12}$/);
    assert.strictEqual(key, sessionKeyFor('/tmp/x.md'));
    assert.notStrictEqual(key, sessionKeyFor('/tmp/y.md'));
  })) passed++; else failed++;

  if (test('canonicalizeArtifactPath resolves relative paths', () => {
    const abs = canonicalizeArtifactPath('some-file.md');
    assert.ok(path.isAbsolute(abs));
  })) passed++; else failed++;

  if (test('normalizeFeedbackItem accepts chat, annotation, verdict', () => {
    assert.strictEqual(normalizeFeedbackItem({ kind: 'chat', text: 'hi' }, 1).kind, 'chat');
    const ann = normalizeFeedbackItem(
      { kind: 'annotation', text: 'fix', anchor: { selector: 'h2', tag: 'h2', snippet: 'Phase 2' } },
      2
    );
    assert.strictEqual(ann.anchor.selector, 'h2');
    const verdict = normalizeFeedbackItem({ kind: 'verdict', verdict: 'approve' }, 3);
    assert.strictEqual(verdict.verdict, 'approve');
  })) passed++; else failed++;

  if (test('normalizeFeedbackItem rejects malformed input', () => {
    assert.strictEqual(normalizeFeedbackItem(null, 1), null);
    assert.strictEqual(normalizeFeedbackItem({ kind: 'nope', text: 'x' }, 1), null);
    assert.strictEqual(normalizeFeedbackItem({ kind: 'chat', text: '' }, 1), null);
    assert.strictEqual(normalizeFeedbackItem({ kind: 'verdict', verdict: 'maybe' }, 1), null);
    assert.strictEqual(normalizeFeedbackItem({ kind: 'annotation', text: 'x' }, 1), null);
    assert.strictEqual(normalizeFeedbackItem({ kind: 'annotation', text: '', anchor: { selector: 'p' } }, 1), null);
  })) passed++; else failed++;

  if (test('normalizeFeedbackItem accepts edit kind with before/after', () => {
    const item = normalizeFeedbackItem({ kind: 'edit', text: '',
      edit: { before: 'старый текст', after: 'новый текст' },
      anchor: { selector: 'p', tag: 'text', snippet: 'старый текст' } }, 1);
    assert.ok(item, 'edit item must be accepted');
    assert.strictEqual(item.kind, 'edit');
    assert.deepStrictEqual(item.edit, { before: 'старый текст', after: 'новый текст' });
  })) passed++; else failed++;

  if (test('edit kind rejected without a real change', () => {
    assert.strictEqual(normalizeFeedbackItem({ kind: 'edit', edit: { before: 'x', after: 'x' },
      anchor: { selector: 'p' } }, 2), null);
    assert.strictEqual(normalizeFeedbackItem({ kind: 'edit', edit: { before: '', after: 'y' },
      anchor: { selector: 'p' } }, 3), null);
  })) passed++; else failed++;

  if (test('chatLineFor renders edit as «before» → «after» with 80-char truncation', () => {
    assert.strictEqual(
      chatLineFor({ kind: 'edit', edit: { before: 'старый текст', after: 'новый текст' } }),
      '✏️ «старый текст» → «новый текст»'
    );
    const longBefore = 'a'.repeat(85);
    assert.strictEqual(
      chatLineFor({ kind: 'edit', edit: { before: longBefore, after: 'ok' } }),
      '✏️ «' + 'a'.repeat(80) + '» → «ok»'
    );
  })) passed++; else failed++;

  console.log('\nOpen / reopen semantics:');

  if (test('open creates a session keyed by canonical path', () => {
    const fx = makeFixture();
    fixtures.push(fx);
    const { session, refused } = fx.store.open(fx.artifact);
    assert.strictEqual(refused, false);
    assert.strictEqual(session.status, 'open');
    assert.strictEqual(session.file, canonicalizeArtifactPath(fx.artifact));
    assert.strictEqual(fx.store.findByFile(fx.artifact).key, session.key);
  })) passed++; else failed++;

  if (test('user-ended sessions refuse a plain reopen but allow --reopen', () => {
    const fx = makeFixture();
    fixtures.push(fx);
    const { session } = fx.store.open(fx.artifact);
    fx.store.end(session.key, 'user');
    assert.strictEqual(fx.store.open(fx.artifact).refused, true);
    const forced = fx.store.open(fx.artifact, { reopen: true });
    assert.strictEqual(forced.refused, false);
    assert.strictEqual(forced.session.status, 'open');
  })) passed++; else failed++;

  if (test('agent-ended sessions reopen without a flag', () => {
    const fx = makeFixture();
    fixtures.push(fx);
    const { session } = fx.store.open(fx.artifact);
    fx.store.end(session.key, 'agent');
    assert.strictEqual(fx.store.open(fx.artifact).refused, false);
  })) passed++; else failed++;

  console.log('\nFeedback queue / deliver-and-drain:');

  if (test('queueFeedback filters bad items and mirrors chat', () => {
    const fx = makeFixture();
    fixtures.push(fx);
    const { session } = fx.store.open(fx.artifact);
    const result = fx.store.queueFeedback(session.key, [
      { kind: 'chat', text: 'hello agent' },
      { kind: 'bogus' },
      { kind: 'verdict', verdict: 'approve' }
    ]);
    assert.strictEqual(result.accepted.length, 2);
    assert.strictEqual(result.pending, 2);
    const chat = fx.store.get(session.key).chat;
    assert.strictEqual(chat.length, 2);
    assert.strictEqual(chat[0].role, 'user');
    assert.ok(chat[1].text.includes('Approved the plan'));
  })) passed++; else failed++;

  if (test('takeFeedback drains once, then returns waiting', () => {
    const fx = makeFixture();
    fixtures.push(fx);
    const { session } = fx.store.open(fx.artifact);
    fx.store.queueFeedback(session.key, [{ kind: 'chat', text: 'one' }]);
    const first = fx.store.takeFeedback(session.key);
    assert.strictEqual(first.status, 'feedback');
    assert.strictEqual(first.items.length, 1);
    assert.strictEqual(fx.store.takeFeedback(session.key).status, 'waiting');
  })) passed++; else failed++;

  if (test('takeFeedback reports missing for unknown sessions', () => {
    const fx = makeFixture();
    fixtures.push(fx);
    assert.strictEqual(fx.store.takeFeedback('deadbeef0000').status, 'missing');
  })) passed++; else failed++;

  if (test('send-and-end delivers final batch with attribution', () => {
    const fx = makeFixture();
    fixtures.push(fx);
    const { session } = fx.store.open(fx.artifact);
    fx.store.queueFeedback(session.key, [{ kind: 'chat', text: 'last words' }], { endSession: true });
    const result = fx.store.takeFeedback(session.key);
    assert.strictEqual(result.status, 'feedback');
    assert.strictEqual(result.sessionEnded, true);
    assert.strictEqual(result.endedBy, 'user');
    const after = fx.store.takeFeedback(session.key);
    assert.strictEqual(after.status, 'ended');
    assert.strictEqual(after.endedBy, 'user');
  })) passed++; else failed++;

  if (test('queueFeedback on an ended session is refused', () => {
    const fx = makeFixture();
    fixtures.push(fx);
    const { session } = fx.store.open(fx.artifact);
    fx.store.end(session.key, 'agent');
    assert.strictEqual(fx.store.queueFeedback(session.key, [{ kind: 'chat', text: 'late' }]), null);
  })) passed++; else failed++;

  console.log('\nPersistence:');

  if (test('queued feedback survives a store reload (server restart)', () => {
    const fx = makeFixture();
    fixtures.push(fx);
    const { session } = fx.store.open(fx.artifact);
    fx.store.queueFeedback(session.key, [{ kind: 'chat', text: 'persist me' }]);
    const reloaded = createSessionStore({ stateDir: fx.store.stateDir });
    const result = reloaded.takeFeedback(session.key);
    assert.strictEqual(result.status, 'feedback');
    assert.strictEqual(result.items[0].text, 'persist me');
  })) passed++; else failed++;

  if (test('corrupt state file starts fresh instead of crashing', () => {
    const fx = makeFixture();
    fixtures.push(fx);
    fs.mkdirSync(fx.store.stateDir, { recursive: true });
    fs.writeFileSync(fx.store.stateFile, '{not json');
    const reloaded = createSessionStore({ stateDir: fx.store.stateDir });
    assert.deepStrictEqual(reloaded.list(), []);
  })) passed++; else failed++;

  if (test('a session missing chat/pendingFeedback/tasks arrays is normalized on load, not thrown on', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eddie-sessions-partial-'));
    fixtures.push({ dir });
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const stateFile = path.join(stateDir, 'sessions.json');
    // Hand-written, valid JSON but a session record missing the array fields
    // real writes always include — simulates a partially-corrupt file.
    fs.writeFileSync(stateFile, JSON.stringify({
      feedbackCounter: 0,
      sessions: {
        deadbeef0001: { key: 'deadbeef0001', file: '/tmp/broken.md', status: 'open' }
      }
    }, null, 2));
    const store = createSessionStore({ stateDir });
    assert.doesNotThrow(() => store.list(), 'list() must not throw on a session missing pendingFeedback');
    assert.deepStrictEqual(store.list()[0], {
      key: 'deadbeef0001', file: '/tmp/broken.md', status: 'open', endedBy: undefined, pending: 0, updatedAt: undefined
    });
    let result;
    assert.doesNotThrow(() => { result = store.takeFeedback('deadbeef0001'); }, 'takeFeedback() must not throw');
    assert.strictEqual(result.status, 'waiting');
  })) passed++; else failed++;

  if (test('addAgentReply appends to the transcript', () => {
    const fx = makeFixture();
    fixtures.push(fx);
    const { session } = fx.store.open(fx.artifact);
    fx.store.addAgentReply(session.key, 'done, take a look');
    const chat = fx.store.get(session.key).chat;
    assert.strictEqual(chat[chat.length - 1].role, 'agent');
  })) passed++; else failed++;

  if (test('list and hasOpenSessions reflect state', () => {
    const fx = makeFixture();
    fixtures.push(fx);
    assert.strictEqual(fx.store.hasOpenSessions(), false);
    const { session } = fx.store.open(fx.artifact);
    assert.strictEqual(fx.store.hasOpenSessions(), true);
    assert.strictEqual(fx.store.list().length, 1);
    fx.store.end(session.key, 'user');
    assert.strictEqual(fx.store.hasOpenSessions(), false);
  })) passed++; else failed++;

  console.log('\nTasks (feedback lifecycle):');

  if (test('takeFeedback turns annotation/chat items into tasks with status sent', () => {
    const fx = makeFixture();
    fixtures.push(fx);
    const { session } = fx.store.open(fx.artifact);
    fx.store.queueFeedback(session.key, [
      { kind: 'annotation', text: 'move this', anchor: { selector: 'p', tag: 'p', snippet: 'x' } },
      { kind: 'chat', text: 'why?' },
      { kind: 'verdict', verdict: 'approve' }
    ]);
    fx.store.takeFeedback(session.key);
    const tasks = fx.store.get(session.key).tasks;
    assert.strictEqual(tasks.length, 2); // verdict задачей не становится
    assert.ok(tasks.every(t => t.status === 'sent'));
  })) passed++; else failed++;

  if (test('resolveTasks updates status and note, ignores unknown ids', () => {
    const fx = makeFixture();
    fixtures.push(fx);
    const { session } = fx.store.open(fx.artifact);
    fx.store.queueFeedback(session.key, [{ kind: 'chat', text: 'q' }]);
    fx.store.takeFeedback(session.key);
    const id = fx.store.get(session.key).tasks[0].id;
    const res = fx.store.resolveTasks(session.key, [
      { id, status: 'answered', note: 'см. чат' },
      { id: 'fb-99999', status: 'done', note: 'nope' }
    ]);
    assert.strictEqual(res.updated, 1);
    const task = fx.store.get(session.key).tasks[0];
    assert.strictEqual(task.status, 'answered');
    assert.strictEqual(task.note, 'см. чат');
    assert.ok(task.resolvedAt);
  })) passed++; else failed++;

  if (test('tasks survive a store reload (server restart)', () => {
    const fx = makeFixture();
    fixtures.push(fx);
    const { session } = fx.store.open(fx.artifact);
    fx.store.queueFeedback(session.key, [{ kind: 'chat', text: 'persist me too' }]);
    fx.store.takeFeedback(session.key);
    const reloaded = createSessionStore({ stateDir: fx.store.stateDir });
    const tasks = reloaded.get(session.key).tasks;
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].status, 'sent');
  })) passed++; else failed++;

  for (const fx of fixtures) {
    try {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  console.log('\n' + '='.repeat(40));
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log('='.repeat(40));

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
