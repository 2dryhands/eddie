// Demo backend for the static landing: stands in for the Eddie server inside
// the browser, so the real canvas (lib/ui.js) runs on GitHub Pages unchanged.
// Notes go to a pretend agent that answers with the JSON a real agent receives.
(function () {
  'use strict';
  const boot = JSON.parse(document.getElementById('pc-session').textContent);
  let es = null;
  const ru = () => (localStorage.getItem('eddie:lang') || navigator.language || 'en').toLowerCase().startsWith('ru'); // as lib/ui.js picks it
  const now = () => new Date().toISOString();
  const chat = boot.chat.map(e => Object.assign({}, e, { at: now() })); // build time would read as the past
  const emit = (type, data) => setTimeout(() => {
    if (!es) return;
    (es.handlers[type] || []).forEach(fn => fn({ data: JSON.stringify(data) }));
  }, 0);
  const syncChat = () => emit('chat-sync', { chat });

  function lineFor(item) { // same wording as lib/sessions.js chatLineFor
    if (item.kind === 'verdict') return item.verdict === 'approve' ? 'Approved the plan' : 'Requested changes';
    if (item.kind === 'annotation') return `[${item.anchor.snippet || item.anchor.selector}] ${item.text}`;
    if (item.kind === 'rating') return `★ ${item.score}/10 · ${item.subject || 'demo-plan.html'}` + (item.text ? ` — ${item.text}` : '');
    if (item.kind === 'edit') return '✏️ «' + item.edit.before.slice(0, 80) + '» → «' + item.edit.after.slice(0, 80) + '»';
    return item.text;
  }
  // What the agent's blocking `await` call returns, trimmed for the chat bubble.
  function agentView(item) {
    const out = { kind: item.kind };
    for (const k of ['text', 'verdict', 'score', 'subject']) if (item[k] != null && item[k] !== '') out[k] = item[k];
    if (item.anchor) out.anchor = { selector: item.anchor.selector, snippet: (item.anchor.snippet || '').slice(0, 60) };
    if (item.edit) out.edit = { before: item.edit.before.slice(0, 60), after: item.edit.after.slice(0, 60) };
    return out;
  }

  function onFeedback(body) {
    const items = body.items || [];
    for (const item of items) {
      const entry = { role: 'user', kind: item.kind, text: lineFor(item), at: now() };
      if (item.kind === 'verdict') entry.verdict = item.verdict;
      chat.push(entry);
    }
    syncChat();
    emit('presence', { state: 'working', pending: 0 });
    setTimeout(() => {
      const approved = items.some(i => i.kind === 'verdict' && i.verdict === 'approve');
      const head = ru()
        ? (approved ? 'Принято, запускаю. Вот что мне пришло:' : `Получил ${items.length} шт. — правлю. Вот что пришло:`)
        : (approved ? 'Approved — shipping it. Here is what I got:' : `Got ${items.length} — on it. Here is what I got:`);
      chat.push({ role: 'agent', kind: 'chat', text: head + '\n' + JSON.stringify(items.map(agentView), null, 1), at: now() });
      syncChat();
      emit('presence', { state: 'listening', pending: 0 });
      if (body.endSession) emit('ended', { endedBy: 'user' });
    }, 900);
  }

  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts = {}) {
    const u = String(url);
    if (u.startsWith('/api/session/')) {
      const action = u.split('/').pop();
      if (action === 'feedback') { onFeedback(JSON.parse(opts.body || '{}')); return json({ ok: true }); }
      if (action === 'ratings') return json({ ratings: {} });
      if (action === 'end') { emit('ended', { endedBy: 'user' }); return json({ ok: true }); }
      return json({ ok: true }); // save, storage, reopen, gone: nothing to keep in a demo
    }
    if (u.startsWith('/health')) return json({ ok: true, version: boot.version });
    return realFetch(url, opts);
  };
  navigator.sendBeacon = () => true;

  function DemoEvents() {
    this.handlers = {};
    es = this;
    emit('presence', { state: 'listening', pending: 0 });
    syncChat();
  }
  DemoEvents.prototype.addEventListener = function (type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); };
  DemoEvents.prototype.close = function () { if (es === this) es = null; };
  window.EventSource = DemoEvents;
})();
