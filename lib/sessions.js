'use strict';

/**
 * Eddie session store.
 *
 * Sessions are keyed by the canonical artifact file path so agents never
 * juggle opaque ids. State is persisted as JSON in the Eddie state
 * dir so queued human feedback survives a server restart.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FEEDBACK_KINDS = new Set(['chat', 'annotation', 'verdict', 'edit']);
const VERDICTS = new Set(['approve', 'request-changes']);
const TASK_STATUSES = new Set(['done', 'answered', 'declined']);

function resolveStateDir(env = process.env) {
  const override = env.EDDIE_STATE_DIR;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(os.homedir(), '.eddie');
}

// Canonicalize so `./plan.md`, symlinks, and absolute paths all land on the
// same session.
function canonicalizeArtifactPath(filePath) {
  const absolute = path.resolve(filePath);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function sessionKeyFor(canonicalPath) {
  return crypto.createHash('sha256').update(canonicalPath).digest('hex').slice(0, 12);
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeText(value, maxLength = 4000) {
  if (typeof value !== 'string') return '';
  return value.slice(0, maxLength);
}

// Normalize one browser-submitted feedback item into the shape delivered to
// the agent. Returns null for unusable input rather than throwing so a
// malformed item can never wedge the queue.
function normalizeFeedbackItem(raw, counter) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = FEEDBACK_KINDS.has(raw.kind) ? raw.kind : null;
  if (!kind) return null;
  const item = {
    id: `fb-${counter}`,
    kind,
    text: sanitizeText(raw.text),
    at: nowIso()
  };
  if (kind === 'verdict') {
    if (!VERDICTS.has(raw.verdict)) return null;
    item.verdict = raw.verdict;
  }
  if (kind === 'annotation') {
    const anchor = raw.anchor && typeof raw.anchor === 'object' ? raw.anchor : null;
    if (!anchor || typeof anchor.selector !== 'string') return null;
    item.anchor = {
      selector: sanitizeText(anchor.selector, 500),
      tag: sanitizeText(anchor.tag, 60),
      snippet: sanitizeText(anchor.snippet, 400)
    };
    if (anchor.textRange && typeof anchor.textRange === 'object') {
      item.anchor.textRange = {
        text: sanitizeText(anchor.textRange.text, 1000)
      };
    }
    if (!item.text) return null;
  }
  if (kind === 'edit') {
    const anchor = raw.anchor && typeof raw.anchor === 'object' ? raw.anchor : null;
    const edit = raw.edit && typeof raw.edit === 'object' ? raw.edit : null;
    if (!anchor || typeof anchor.selector !== 'string' || !edit) return null;
    const before = sanitizeText(edit.before, 2000);
    const after = sanitizeText(edit.after, 2000);
    if (!before || !after || before === after) return null;
    item.anchor = {
      selector: sanitizeText(anchor.selector, 500),
      tag: sanitizeText(anchor.tag, 60),
      snippet: sanitizeText(anchor.snippet, 400)
    };
    item.edit = { before, after };
  }
  if (kind === 'chat' && !item.text) return null;
  return item;
}

function createSessionStore({ stateDir = resolveStateDir() } = {}) {
  const stateFile = path.join(stateDir, 'sessions.json');
  let state = { sessions: {}, feedbackCounter: 0 };

  // A hand-edited or partially-written sessions.json can be missing fields
  // on individual sessions (chat/pendingFeedback/tasks) even when the file
  // as a whole parses as valid JSON. Every code path below assumes these are
  // arrays (.length, .push, .find, .filter) — normalize once on load so one
  // malformed session can never throw and brick the whole API.
  function normalizeSession(session) {
    if (!session || typeof session !== 'object') return session;
    if (!Array.isArray(session.chat)) session.chat = [];
    if (!Array.isArray(session.pendingFeedback)) session.pendingFeedback = [];
    if (!Array.isArray(session.tasks)) session.tasks = [];
    return session;
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.sessions) {
        const sessions = {};
        for (const [key, session] of Object.entries(parsed.sessions)) {
          sessions[key] = normalizeSession(session);
        }
        state = {
          sessions,
          feedbackCounter: Number(parsed.feedbackCounter) || 0
        };
      }
    } catch {
      // Missing or corrupt state starts fresh; queued feedback loss on a
      // corrupt file beats refusing to start at all.
    }
  }

  function persist() {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmpFile = `${stateFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    fs.renameSync(tmpFile, stateFile);
  }

  load();

  function get(key) {
    return state.sessions[key] || null;
  }

  function findByFile(filePath) {
    const canonical = canonicalizeArtifactPath(filePath);
    return get(sessionKeyFor(canonical));
  }

  // Open (or resume) a session. A session the *user* ended from the browser
  // is sticky: it refuses a plain reopen so agents do not pop the browser
  // back up uninvited. Pass reopen:true only when the human asked.
  function open(filePath, { reopen = false } = {}) {
    const canonical = canonicalizeArtifactPath(filePath);
    const key = sessionKeyFor(canonical);
    const existing = state.sessions[key];
    if (existing && existing.status === 'ended' && existing.endedBy === 'user' && !reopen) {
      return { session: existing, refused: true };
    }
    const session = existing || {
      key,
      file: canonical,
      chat: [],
      pendingFeedback: [],
      tasks: [],
      createdAt: nowIso()
    };
    if (!session.tasks) session.tasks = [];
    session.status = 'open';
    delete session.endedBy;
    session.updatedAt = nowIso();
    state.sessions[key] = session;
    persist();
    return { session, refused: false };
  }

  // Queue feedback from the browser. Chat-shaped items are mirrored into the
  // session transcript immediately so the conversation panel stays coherent
  // across reloads.
  function queueFeedback(key, rawItems, { endSession = false } = {}) {
    const session = get(key);
    if (!session || session.status === 'ended') return null;
    const accepted = [];
    for (const raw of Array.isArray(rawItems) ? rawItems : []) {
      state.feedbackCounter += 1;
      const item = normalizeFeedbackItem(raw, state.feedbackCounter);
      if (item) accepted.push(item);
    }
    session.pendingFeedback.push(...accepted);
    for (const item of accepted) {
      // `text` stays the chatLineFor() rendering (English label baked in) for
      // backward compat with legacy sessions and any agent-facing reading of
      // chat. Verdict entries additionally carry `verdict` (approve /
      // request-changes, so the client can localize the label) and `vtext`
      // (the raw user comment, if any, so the client doesn't have to parse
      // it back out of `text`).
      const entry = { role: 'user', kind: item.kind, text: chatLineFor(item), at: item.at };
      if (item.kind === 'verdict') {
        entry.verdict = item.verdict;
        entry.vtext = item.text;
      }
      session.chat.push(entry);
    }
    if (endSession) {
      session.status = 'ended';
      session.endedBy = 'user';
    } else if (accepted.length > 0) {
      session.status = 'feedback';
    }
    session.updatedAt = nowIso();
    persist();
    return { accepted, pending: session.pendingFeedback.length, session };
  }

  // Deliver-and-drain: feedback is handed to exactly one await call, after
  // which the session flips back to open. An ended session keeps reporting
  // ended (with attribution) so agents know to stop polling.
  function takeFeedback(key) {
    const session = get(key);
    if (!session) return { status: 'missing' };
    if (session.pendingFeedback.length > 0) {
      const items = session.pendingFeedback;
      session.pendingFeedback = [];
      for (const item of items) {
        if (item.kind === 'verdict') continue;
        session.tasks.push({ id: item.id, kind: item.kind, text: item.text, anchor: item.anchor,
          edit: item.edit, at: item.at, status: 'sent' });
      }
      const result = { status: 'feedback', items };
      if (session.status === 'ended') {
        result.sessionEnded = true;
        result.endedBy = session.endedBy;
      } else {
        session.status = 'open';
      }
      session.updatedAt = nowIso();
      persist();
      return result;
    }
    if (session.status === 'ended') {
      return { status: 'ended', endedBy: session.endedBy };
    }
    return { status: 'waiting' };
  }

  function addAgentReply(key, text) {
    const session = get(key);
    if (!session) return null;
    const entry = { role: 'agent', kind: 'chat', text: sanitizeText(text), at: nowIso() };
    session.chat.push(entry);
    session.updatedAt = nowIso();
    persist();
    return entry;
  }

  function end(key, endedBy) {
    const session = get(key);
    if (!session) return null;
    session.status = 'ended';
    session.endedBy = endedBy === 'user' ? 'user' : 'agent';
    session.updatedAt = nowIso();
    persist();
    return session;
  }

  function list() {
    return Object.values(state.sessions).map(session => ({
      key: session.key,
      file: session.file,
      status: session.status,
      endedBy: session.endedBy,
      pending: session.pendingFeedback.length,
      updatedAt: session.updatedAt
    }));
  }

  function hasOpenSessions() {
    return Object.values(state.sessions).some(session => session.status !== 'ended');
  }

  function resolveTasks(key, resolutions) {
    const session = get(key);
    if (!session) return null;
    let updated = 0;
    for (const r of Array.isArray(resolutions) ? resolutions : []) {
      if (!r || !TASK_STATUSES.has(r.status)) continue;
      const task = (session.tasks || []).find(t => t.id === r.id);
      if (!task) continue;
      task.status = r.status;
      task.note = sanitizeText(r.note || '', 1000);
      task.resolvedAt = nowIso();
      updated += 1;
    }
    if (updated) { session.updatedAt = nowIso(); persist(); }
    return { updated };
  }

  return {
    stateDir,
    stateFile,
    open,
    get,
    findByFile,
    queueFeedback,
    takeFeedback,
    addAgentReply,
    end,
    list,
    hasOpenSessions,
    resolveTasks
  };
}

// One-line rendering of a feedback item for the conversation transcript.
function chatLineFor(item) {
  if (item.kind === 'verdict') {
    const label = item.verdict === 'approve' ? 'Approved the plan' : 'Requested changes';
    return item.text ? `${label}: ${item.text}` : label;
  }
  if (item.kind === 'annotation') {
    const where = item.anchor.snippet || item.anchor.selector;
    return `[${where}] ${item.text}`;
  }
  if (item.kind === 'edit') {
    return '✏️ «' + item.edit.before.slice(0, 80) + '» → «' + item.edit.after.slice(0, 80) + '»';
  }
  return item.text;
}

module.exports = {
  canonicalizeArtifactPath,
  chatLineFor,
  createSessionStore,
  normalizeFeedbackItem,
  resolveStateDir,
  sessionKeyFor
};
