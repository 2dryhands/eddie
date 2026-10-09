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
  let editable = false;
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
    .hl .tag{position:absolute;left:-1.5px;bottom:100%;margin-bottom:2px;white-space:nowrap;background:#6885e8;color:#fff;font:600 10px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:2px 6px;border-radius:3px}
    .pick{position:absolute;pointer-events:none;border:1.5px dashed #6885e8;background:rgba(104,133,232,0.10);border-radius:4px;z-index:2147483645}
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
    .card.peek{opacity:.25;pointer-events:none}
    .card .keys{padding:0 12px 10px;font-size:9.5px;color:#4c5168}
  </style>
  <div class="hl"><span class="tag"></span></div>
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
  const hlTag = hl.querySelector('.tag');
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
      if (INTERACTIVE.has(node.tagName.toLowerCase())) return true;
      // Live editing makes every text block contenteditable; counting those as
      // controls left only gaps between blocks pickable, i.e. the whole page.
      if (node.getAttribute('contenteditable') === 'true' && !node.hasAttribute('data-edit')) return true;
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
    hl.style.display = 'none';
    hoverBase = hoverEl = null;
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
    cardEl.classList.remove('peek');
    root.querySelectorAll('.pick').forEach(n => n.remove());
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
  // Keys typed into the card must not reach the artifact: retargeted out of the
  // shadow root they look like keys on a plain <div>, so a page that binds
  // Space (play/pause) or letters to shortcuts swallows them mid-typing.
  ['keydown', 'keypress', 'keyup'].forEach(t => cardEl.addEventListener(t, e => e.stopPropagation()));

  // --- element hover / click ---------------------------------------------
  // The pointer lands on the deepest element (a <b> inside a tile); arrows walk
  // (with Option/Alt) to the parent and back so the reviewer can pick the block they mean, and
  // Shift+click adds sibling blocks (a heading plus its table) to one note.
  let hoverBase = null;
  let hoverEl = null;
  const pickable = el => el && el.nodeType === 1 && !isOurs(el) && el !== document.body &&
    el !== document.documentElement && !isInteractive(el);
  function showHl(el) {
    if (!pickable(el)) { hl.style.display = 'none'; return; }
    const rect = el.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = rect.left - 2 + 'px';
    hl.style.top = rect.top - 2 + 'px';
    hl.style.width = rect.width + 'px';
    hl.style.height = rect.height + 'px';
    hlTag.textContent = '<' + el.tagName.toLowerCase() + '>  ' + (strings.sdkPickHint || '⌥↑ wider · ⌥↓ narrower · Shift+click add');
  }
  document.addEventListener('mousemove', e => {
    if (!annotate || (card && !card.els) || (card && cardEl.contains(e.composedPath()[0]))) { hl.style.display = 'none'; return; }
    if (e.target !== hoverBase) { hoverBase = e.target; hoverEl = e.target; }
    showHl(hoverEl);
  }, true);
  document.addEventListener('mouseout', e => {
    if (!e.relatedTarget) { hoverBase = hoverEl = null; hl.style.display = 'none'; } // pointer left the artifact
  }, true);
  function pickStep(dir) {
    if (!annotate || (card && !card.els) || !hoverEl) return;
    let next = null;
    if (dir === 'up') next = hoverEl.parentElement;
    else if (hoverEl !== hoverBase) {
      next = hoverBase;
      while (next.parentElement && next.parentElement !== hoverEl) next = next.parentElement;
    }
    if (pickable(next)) { hoverEl = next; showHl(hoverEl); }
  }
  document.addEventListener('keydown', e => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    // Option/Alt: plain arrows still scroll the page.
    if (!annotate || (card && !card.els) || !hoverEl || !e.altKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    pickStep(e.key === 'ArrowUp' ? 'up' : 'down');
  }, true);
  function markPick(el) {
    const rect = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'pick';
    box.style.cssText = 'left:' + (rect.left + window.scrollX - 2) + 'px;top:' + (rect.top + window.scrollY - 2) +
      'px;width:' + rect.width + 'px;height:' + rect.height + 'px';
    root.appendChild(box);
  }
  function elementTarget(els, x, y) {
    const tags = els.map(el => el.tagName.toLowerCase());
    return {
      els,
      kindLabel: (strings.sdkAnnotatePrefix || 'Annotate') + ' <' + tags.join('> + <') + '>',
      anchor: { selector: els.map(selectorFor).join(', '), tag: tags.join('+'), snippet: els.map(snippetFor).join(' … ') },
      x, y
    };
  }

  document.addEventListener('click', e => {
    if (!annotate) return;
    const el = hoverEl && hoverEl.contains(e.target) ? hoverEl : e.target;
    if (isOurs(el)) return;
    if (card) {
      if (cardEl.contains(e.composedPath()[0])) return;
      if (e.shiftKey && card.els && pickable(el) && !card.els.includes(el)) {
        e.preventDefault();
        e.stopPropagation();
        const els = card.els.filter(p => !el.contains(p)).concat(el);
        const next = elementTarget(els, card.x, card.y);
        Object.assign(card, next);
        cardTitle.textContent = card.kindLabel;
        cardSnippet.textContent = card.anchor.snippet || card.anchor.selector;
        root.querySelectorAll('.pick').forEach(n => n.remove());
        els.forEach(markPick);
        cardText.focus();
        return;
      }
      closeCard();
      return;
    }
    if (!pickable(el)) return; // let controls behave natively
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return; // handled by selection flow
    e.preventDefault();
    e.stopPropagation();
    hl.style.display = 'none';
    openCard(elementTarget([el], e.clientX, e.clientY));
    markPick(el);
  }, true);

  // Holding Shift turns the card see-through and click-through: it opens right
  // below the first pick, on top of the block most likely to be added next.
  let peekTimer = null;
  const peek = on => {
    clearTimeout(peekTimer);
    if (!on) { cardEl.classList.remove('peek'); return; }
    peekTimer = setTimeout(() => cardEl.classList.toggle('peek', Boolean(card && card.els)), 200);
  };
  document.addEventListener('keydown', e => {
    if (e.key === 'Shift') peek(true);
    else if (e.key.length === 1) peek(false); // a capital letter is being typed
  }, true);
  document.addEventListener('keyup', e => { if (e.key === 'Shift') peek(false); }, true);
  window.addEventListener('blur', () => peek(false));

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
      syncEditing();
    } else if (msg.type === 'pc:checks') {
      setupChecklist(msg.checked || []);
    } else if (msg.type === 'pc:pick') {
      pickStep(msg.dir);
    } else if (msg.type === 'pc:set-lang') {
      strings = msg.strings || {};
      syncStrings();
    } else if (msg.type === 'pc:restore-scroll') {
      window.scrollTo(msg.x || 0, msg.y || 0);
    } else if (msg.type === 'pc:collect-blocks') {
      post({ type: 'pc:blocks', texts: collectBlockTexts() });
    } else if (msg.type === 'pc:set-baseline') {
      applyBaseline(new Set(msg.texts || []));
    } else if (msg.type === 'pc:set-editable') {
      editable = Boolean(msg.editable);
      if (editable) enableEditing();
    } else if (msg.type === 'pc:collect-clean') {
      post({ type: 'pc:clean', html: cleanHtml() });
    }
  });
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      post({ type: 'pc:toggle-mode' });
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      post({ type: 'pc:toggle-panel' });
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

  // --- review checklist ------------------------------------------------------
  // The agent's "what to check in this update" block gets a checkbox per item:
  // checked items strike through, fade out, and come back via "show checked".
  // State lives in the chrome (the sandboxed iframe has no storage), keyed by
  // item text, so items an agent rewrites come back unchecked.
  const CHECK_HEAD = /^(что проверять|what to check)/i;
  let checklistDone = false;
  function checkKey(el) { return (el.innerText || el.textContent || '').replace(/[ \\t\\n\\r]+/g, ' ').trim().slice(0, 300); }
  function findChecklist() {
    const heads = Array.from(document.body.querySelectorAll('h1,h2,h3,h4,h5,h6,b,strong,p,div,span'))
      .filter(el => !isOurs(el) && CHECK_HEAD.test(checkKey(el)) && checkKey(el).length < 80);
    for (const head of heads) {
      let box = head.parentElement;
      for (let i = 0; box && box !== document.body && i < 3; i++, box = box.parentElement) {
        const lis = Array.from(box.querySelectorAll('li'));
        if (lis.length) return { box, items: lis };
        const rows = Array.from(box.children).filter(c => c !== head && !c.contains(head) && checkKey(c));
        if (rows.length >= 2) return { box, items: rows };
      }
    }
    return null;
  }
  function setupChecklist(checked) {
    if (checklistDone || !document.body) return;
    const found = findChecklist();
    if (!found) return;
    checklistDone = true;
    const done = new Set(checked);
    const style = document.createElement('style');
    style.setAttribute('data-eddie', 'checks');
    style.textContent = '.pc-check-item{transition:opacity .6s ease,max-height .8s ease .3s,margin .8s ease .3s,padding .8s ease .3s;max-height:400px;overflow:hidden}' +
      '.pc-check-item.pc-done{text-decoration:line-through;opacity:.45}' +
      '.pc-check-item.pc-gone{max-height:0;opacity:0;margin-top:0;margin-bottom:0;padding-top:0;padding-bottom:0}' +
      '.pc-check-box{margin:0 8px 0 0;width:16px;height:16px;vertical-align:-2px;cursor:pointer;accent-color:#6885e8}' +
      '.pc-check-more{display:block;margin-top:6px;background:none;border:0;padding:2px 0;color:#6885e8;font:inherit;font-size:.85em;cursor:pointer}';
    document.head.appendChild(style);
    let showGone = false;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'pc-check-more';
    more.setAttribute('data-eddie', 'checks');
    const refresh = () => {
      const n = found.items.filter(it => it.classList.contains('pc-done')).length;
      more.style.display = n ? '' : 'none';
      more.textContent = showGone ? (strings.sdkHideChecked || 'Hide checked') : (strings.sdkShowChecked || 'Show checked') + ' (' + n + ')';
      found.items.forEach(it => it.classList.toggle('pc-gone', it.classList.contains('pc-done') && !showGone && !inside));
    };
    // Checked items strike through at once but collapse only when the pointer
    // leaves the block, so the next item doesn't jump away from the cursor.
    let inside = false;
    found.box.addEventListener('mouseenter', () => { inside = true; });
    found.box.addEventListener('mouseleave', () => { inside = false; refresh(); });
    found.items.forEach(it => {
      const key = checkKey(it);
      it.classList.add('pc-check-item');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'pc-check-box';
      cb.setAttribute('data-eddie', 'checks');
      cb.checked = done.has(key);
      it.classList.toggle('pc-done', cb.checked);
      it.insertBefore(cb, it.firstChild);
      cb.addEventListener('change', () => {
        it.classList.toggle('pc-done', cb.checked);
        post({ type: 'pc:check', key, checked: cb.checked });
        refresh();
      });
    });
    more.addEventListener('click', () => { showGone = !showGone; refresh(); });
    (found.items[found.items.length - 1].parentElement || found.box).appendChild(more);
    refresh();
  }

  // --- live text editing (HTML artifacts only) -----------------------------
  // Blocks become contenteditable so the reviewer types straight into the
  // document; each edit serialises a clean copy (Eddie UI + editing markup
  // stripped) back to the chrome, which writes it to the source file and
  // offers it for download. Comments to the agent still go via text selection.
  const EDIT_SEL = 'h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,figcaption,dt,dd';
  // A tag list alone only covers documents written in semantic HTML. Real
  // artifacts — dashboards, cards, generated reports — put most of their text
  // in <div> and <span>, and those used to be uneditable: the reviewer had to
  // fall back to leaving a comment for the agent instead of just fixing the
  // wording. So the rule is structural, not tag-based: any element that owns
  // a non-empty text node of its own is a text block. Layout containers never
  // qualify — their text lives in children, not in them.
  const EDIT_SKIP = new Set(['SCRIPT', 'STYLE', 'TITLE', 'A', 'BUTTON', 'INPUT', 'TEXTAREA',
    'SELECT', 'OPTION', 'LABEL', 'SUMMARY', 'CODE', 'PRE', 'IFRAME', 'SVG', 'CANVAS']);
  function ownsText(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return false;
  }
  function makeEditable(el) {
    if (el.hasAttribute('data-edit')) return;
    el.setAttribute('spellcheck', 'false');
    el.setAttribute('data-edit', '');
  }
  // Text is editable only with notes off. With notes on, editable blocks put a
  // caret on every click (stray keys landed in the file) and clamp a mouse
  // selection to one paragraph, so a whole card could not be selected.
  function syncEditing() {
    const on = editable && !annotate ? 'true' : 'false';
    document.querySelectorAll('[data-edit]').forEach(el => el.setAttribute('contenteditable', on));
    if (on === 'false' && document.activeElement && document.activeElement.hasAttribute &&
        document.activeElement.hasAttribute('data-edit')) document.activeElement.blur();
  }
  function enableEditing() {
    document.querySelectorAll(EDIT_SEL).forEach(el => {
      if (isOurs(el) || el.closest('[data-eddie]')) return;
      if (el.querySelector(EDIT_SEL)) return; // container of editable children — edit the children instead
      makeEditable(el);
    });
    const body = document.body;
    if (!body) return;
    body.querySelectorAll('*').forEach(el => {
      if (isOurs(el) || el.closest('[data-eddie]')) return;
      if (EDIT_SKIP.has(el.tagName)) return;
      if (el.closest('[data-edit]')) return; // already inside an editable block
      if (!ownsText(el)) return;             // container, not a text block
      makeEditable(el);
    });
    syncEditing();
  }
  function cleanHtml() {
    const root = document.documentElement.cloneNode(true);
    root.querySelectorAll('[data-eddie]').forEach(n => n.remove());          // Eddie shadow-UI host
    root.querySelectorAll('script[src="/sdk.js"]').forEach(n => n.remove()); // injected SDK
    root.querySelectorAll('[data-edit]').forEach(n => {
      n.removeAttribute('contenteditable'); n.removeAttribute('spellcheck'); n.removeAttribute('data-edit');
    });
    root.querySelectorAll('.pc-changed').forEach(n => n.classList.remove('pc-changed'));
    root.querySelectorAll('.pc-check-item').forEach(n => {
      n.classList.remove('pc-check-item', 'pc-done', 'pc-gone');
      if (!n.classList.length) n.removeAttribute('class');
    });
    root.querySelectorAll('style').forEach(s => { if (s.textContent.includes('.pc-changed')) s.remove(); });
    const dt = document.doctype ? '<!doctype ' + document.doctype.name + '>\\n' : '';
    return dt + root.outerHTML;
  }
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => post({ type: 'pc:save', html: cleanHtml() }), 650);
  }
  document.addEventListener('input', e => {
    if (!editable) return;
    if (!(e.target.closest && e.target.closest('[data-edit]'))) return;
    if (e.target.closest('[data-eddie]')) return; // our checklist boxes, not the reviewer's text
    scheduleSave();
  });
  // Keep contenteditable from injecting <div>/styled markup: Enter = a plain
  // line break, paste = plain text only.
  document.addEventListener('keydown', e => {
    if (!editable || e.key !== 'Enter' || e.shiftKey) return;
    if (e.target.closest && e.target.closest('[data-edit]')) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
    }
  }, true);
  document.addEventListener('paste', e => {
    if (!editable) return;
    const el = e.target.closest && e.target.closest('[data-edit]');
    if (!el) return;
    e.preventDefault();
    const txt = ((e.clipboardData || window.clipboardData).getData('text') || '');
    document.execCommand('insertText', false, txt);
  });

  post({ type: 'pc:ready' });
})();`;
}

module.exports = { artifactSdkJs };
