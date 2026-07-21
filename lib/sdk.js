'use strict';

/**
 * Eddie artifact SDK — the script injected into the reviewed artifact.
 *
 * The artifact runs in a sandboxed iframe without allow-same-origin, so this
 * script can only talk to the chrome via postMessage. It renders all of its
 * own UI inside a shadow root so it never annotates itself and never leaks
 * styles into the artifact.
 */

function artifactSdkJs() {
  return `'use strict';
(() => {
  if (window.parent === window) return; // only meaningful inside the canvas
  if (window.__eddieSdk) return;
  window.__eddieSdk = true;

  let annotate = true;
  let card = null;
  let strings = {};

  const post = msg => window.parent.postMessage(msg, '*');

  // --- shadow-root UI host --------------------------------------------
  const host = document.createElement('div');
  host.setAttribute('data-eddie', 'ui');
  host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = \`
  <style>
    :host{all:initial}
    .hl{position:fixed;pointer-events:none;border:1.5px solid #6885e8;background:rgba(104,133,232,0.12);border-radius:4px;display:none;z-index:2147483646;transition:all .06s ease-out}
    .card{position:absolute;display:none;z-index:2147483647;width:300px;background:#101218;border:1px solid #272c3e;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.6);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#dfe2e9}
    .card h4{margin:0;padding:10px 12px 0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#80859a}
    .card .snippet{padding:4px 12px 0;font:10.5px 'SF Mono','Fira Code',monospace;color:#4acbbe;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .card .editlabel{display:none;padding:8px 12px 0;font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#80859a}
    .card textarea{display:block;width:calc(100% - 24px);margin:8px 12px;min-height:56px;resize:vertical;background:#13161e;border:1px solid #1d2130;border-radius:6px;color:#dfe2e9;font:12.5px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:7px 9px;outline:none;box-sizing:border-box}
    .card textarea:focus{border-color:#6885e8}
    .card .edittext,.card .comment-text{display:none}
    .card.mode-selection .snippet,.card.mode-selection .click-text{display:none}
    .card.mode-selection .editlabel,.card.mode-selection .edittext,.card.mode-selection .comment-text{display:block}
    .card .row{display:flex;justify-content:flex-end;gap:8px;padding:0 12px 12px}
    .card button{border-radius:6px;font:600 11.5px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:5px 12px;cursor:pointer}
    .card .cancel{background:none;border:1px solid #1d2130;color:#80859a}
    .card .cancel:hover{color:#dfe2e9;border-color:#272c3e}
    .card .queue{background:#6885e8;border:1px solid #6885e8;color:#fff}
    .card .queue:hover{background:#3d5ab8}
    .card .keys{padding:0 12px 10px;font-size:9.5px;color:#4c5168}
  </style>
  <div class="hl"></div>
  <div class="card">
    <h4></h4>
    <div class="snippet"></div>
    <textarea class="click-text" placeholder="What should change here?"></textarea>
    <div class="editlabel">Edit the text as it should read:</div>
    <textarea class="edittext"></textarea>
    <div class="editlabel comment">Comment (optional)</div>
    <textarea class="comment-text"></textarea>
    <div class="row">
      <button class="cancel" type="button">Cancel</button>
      <button class="queue" type="button">Queue</button>
    </div>
    <div class="keys">Enter to queue &middot; Cmd/Ctrl+Enter to queue &amp; send</div>
  </div>\`;
  const attach = () => document.body ? document.body.appendChild(host) : null;
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach);

  const hl = root.querySelector('.hl');
  const cardEl = root.querySelector('.card');
  const cardTitle = cardEl.querySelector('h4');
  const cardSnippet = cardEl.querySelector('.snippet');
  const cardText = cardEl.querySelector('.click-text');
  const cardEditLabel = cardEl.querySelector('.editlabel');
  const cardEditText = cardEl.querySelector('.edittext');
  const cardCommentLabel = cardEl.querySelector('.editlabel.comment');
  const cardCommentText = cardEl.querySelector('.comment-text');

  // --- i18n --------------------------------------------------------------
  function syncStrings() {
    if (strings.sdkCardPlaceholder) cardText.placeholder = strings.sdkCardPlaceholder;
    if (strings.sdkEditLabel) cardEditLabel.textContent = strings.sdkEditLabel;
    if (strings.sdkCommentOptional) cardCommentLabel.textContent = strings.sdkCommentOptional;
    if (strings.sdkCancel) cardEl.querySelector('.cancel').textContent = strings.sdkCancel;
    if (strings.sdkQueue) cardEl.querySelector('.queue').textContent = strings.sdkQueue;
    if (strings.sdkKeys) cardEl.querySelector('.keys').textContent = strings.sdkKeys;
  }

  // --- selectors & context ---------------------------------------------
  const esc = v => (window.CSS && CSS.escape) ? CSS.escape(v) : v.replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  function selectorFor(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth++) {
      if (node.id) { parts.unshift('#' + esc(node.id)); return parts.join(' > '); }
      const tag = node.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') { parts.unshift(tag); break; }
      let nth = 1;
      let sib = node;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) nth++;
      parts.unshift(tag + ':nth-of-type(' + nth + ')');
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function snippetFor(el) {
    return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
  }
  const INTERACTIVE = new Set(['button', 'input', 'select', 'textarea', 'option', 'label', 'summary', 'a']);
  function isInteractive(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (INTERACTIVE.has(node.tagName.toLowerCase()) || node.isContentEditable) return true;
      node = node.parentElement;
    }
    return false;
  }
  const isOurs = el => el === host || host.contains(el);

  // --- change highlighting -------------------------------------------------
  // Snapshot/restore of block texts so the chrome can flag what the agent
  // changed since the last time feedback was sent. Language-independent —
  // no i18n strings involved.
  const BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,td,th';
  function normBlock(el) {
    return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  }
  function blockEls() {
    if (!document.body) return [];
    return Array.from(document.body.querySelectorAll(BLOCK_SELECTOR)).filter(el => !isOurs(el));
  }
  function collectBlockTexts() {
    return blockEls().map(normBlock).filter(Boolean);
  }
  let baselineStyleInjected = false;
  function ensureBaselineStyle() {
    if (baselineStyleInjected) return;
    baselineStyleInjected = true;
    const st = document.createElement('style');
    st.textContent = '.pc-changed{background:rgba(236,168,90,.14);box-shadow:inset 3px 0 0 #eca85a;border-radius:2px}';
    (document.head || document.documentElement).appendChild(st);
  }
  function applyBaseline(set) {
    if (!set.size) return; // nothing stored yet (first-ever open) — no highlighting
    ensureBaselineStyle();
    // Document order visits parent blocks before their nested descendants,
    // so a mark applied to a parent is already in place by the time we
    // reach its children below — skip those to avoid double-marking.
    for (const el of blockEls()) {
      const text = normBlock(el);
      if (!text || set.has(text)) continue;
      if (el.parentElement && el.parentElement.closest('.pc-changed')) continue;
      el.classList.add('pc-changed');
    }
  }

  // --- annotation / edit card ---------------------------------------------
  function openCard(target) {
    card = target;
    const selectionMode = target.mode === 'selection';
    cardEl.classList.toggle('mode-selection', selectionMode);
    cardTitle.textContent = target.kindLabel;
    if (selectionMode) {
      cardEditText.value = target.selText;
      cardCommentText.value = '';
    } else {
      cardSnippet.textContent = target.anchor.snippet || target.anchor.selector;
      cardText.value = '';
    }
    cardEl.style.display = 'block';
    const x = Math.min(target.x, window.innerWidth - 320) + window.scrollX;
    const y = target.y + 12 + window.scrollY;
    cardEl.style.left = Math.max(8, x) + 'px';
    cardEl.style.top = y + 'px';
    (selectionMode ? cardEditText : cardText).focus();
  }
  function closeCard() {
    card = null;
    cardEl.style.display = 'none';
  }
  function queueCard(sendNow) {
    if (!card) return;
    if (card.mode === 'selection') {
      const after = cardEditText.value.trim();
      const comment = cardCommentText.value.trim();
      let item = null;
      if (after && after !== card.selText) {
        item = { kind: 'edit', text: comment, edit: { before: card.selText, after }, anchor: card.anchor };
      } else if (comment) {
        item = { kind: 'annotation', text: comment, anchor: card.anchor };
      } else {
        cardCommentText.focus();
        return;
      }
      post({ type: sendNow ? 'pc:queue-and-send' : 'pc:queue', item });
      closeCard();
      return;
    }
    const text = cardText.value.trim();
    if (!text) { cardText.focus(); return; }
    post({
      type: sendNow ? 'pc:queue-and-send' : 'pc:queue',
      item: { kind: 'annotation', text, anchor: card.anchor }
    });
    closeCard();
  }
  cardEl.querySelector('.cancel').addEventListener('click', closeCard);
  cardEl.querySelector('.queue').addEventListener('click', () => queueCard(false));
  function cardKeydown(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); queueCard(true); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); queueCard(false); }
    else if (e.key === 'Escape') closeCard();
  }
  cardText.addEventListener('keydown', cardKeydown);
  cardEditText.addEventListener('keydown', cardKeydown);
  cardCommentText.addEventListener('keydown', cardKeydown);

  // --- element hover / click ---------------------------------------------
  document.addEventListener('mousemove', e => {
    if (!annotate || card) { hl.style.display = 'none'; return; }
    const el = e.target;
    if (!el || isOurs(el) || el === document.body || el === document.documentElement || isInteractive(el)) {
      hl.style.display = 'none';
      return;
    }
    const rect = el.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = rect.left - 2 + 'px';
    hl.style.top = rect.top - 2 + 'px';
    hl.style.width = rect.width + 'px';
    hl.style.height = rect.height + 'px';
  }, true);

  document.addEventListener('click', e => {
    if (!annotate) return;
    const el = e.target;
    if (isOurs(el)) return;
    if (card) { if (!cardEl.contains(e.composedPath()[0])) closeCard(); return; }
    if (isInteractive(el)) return; // let controls behave natively
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return; // handled by selection flow
    if (el === document.body || el === document.documentElement) return;
    e.preventDefault();
    e.stopPropagation();
    hl.style.display = 'none';
    openCard({
      kindLabel: (strings.sdkAnnotatePrefix || 'Annotate') + ' <' + el.tagName.toLowerCase() + '>',
      anchor: { selector: selectorFor(el), tag: el.tagName.toLowerCase(), snippet: snippetFor(el) },
      x: e.clientX,
      y: e.clientY
    });
  }, true);

  // --- text selection -------------------------------------------------------
  document.addEventListener('mouseup', e => {
    if (!annotate || card || isOurs(e.target)) return;
    setTimeout(() => {
      if (card) return; // a click already opened a card in the meantime
      const selection = window.getSelection();
      const text = selection ? String(selection).replace(/\\s+/g, ' ').trim() : '';
      if (!text || !selection.rangeCount) return;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const anchorNode = selection.anchorNode;
      const el = anchorNode && anchorNode.nodeType === 1 ? anchorNode : anchorNode && anchorNode.parentElement;
      openCard({
        mode: 'selection',
        selText: text,
        kindLabel: strings.sdkAnnotateSelection || 'Annotate selection',
        anchor: {
          selector: el ? selectorFor(el) : 'body',
          tag: 'text',
          snippet: text.slice(0, 200),
          textRange: { text: text.slice(0, 1000) }
        },
        x: rect.left,
        y: rect.bottom
      });
    }, 0);
  }, true);

  // --- chrome bridge ---------------------------------------------------------
  window.addEventListener('message', e => {
    const msg = e.data || {};
    if (msg.type === 'pc:set-mode') {
      annotate = Boolean(msg.annotate);
      if (!annotate) { hl.style.display = 'none'; closeCard(); }
    } else if (msg.type === 'pc:set-lang') {
      strings = msg.strings || {};
      syncStrings();
    } else if (msg.type === 'pc:restore-scroll') {
      window.scrollTo(msg.x || 0, msg.y || 0);
    } else if (msg.type === 'pc:collect-blocks') {
      post({ type: 'pc:blocks', texts: collectBlockTexts() });
    } else if (msg.type === 'pc:set-baseline') {
      applyBaseline(new Set(msg.texts || []));
    }
  });
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      post({ type: 'pc:toggle-mode' });
    } else if (e.key === 'Escape' && card) closeCard();
  }, true);

  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      post({ type: 'pc:scroll', x: window.scrollX, y: window.scrollY });
    }, 150);
  }, { passive: true });

  post({ type: 'pc:ready' });
})();`;
}

module.exports = { artifactSdkJs };
