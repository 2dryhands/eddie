---
name: eddie
description: Open plans and Markdown/HTML artifacts in a local browser canvas where a human annotates elements, edits text inline, chats, and clicks Send or Ship it to hand back feedback or accept the work — while the agent blocks on a single CLI call that returns their feedback as structured JSON. Use when presenting a plan or report for review, when feedback is easier pointed at than typed, or when the human wants to edit text directly and have the agent apply the exact change.
metadata:
  origin: eddie
version: "1.0.0"
---

# Eddie

Review loop for plans and local artifacts: you write the artifact, the human
reviews it in the browser — annotating the exact element they mean, editing
text inline, chatting, and clicking **Send** (keep the loop going) or
**Ship it** (final acceptance) — while you block on a single CLI call that
returns their feedback as JSON.

Extracted and evolved from the `plan-canvas` tool in
[everything-claude-code](https://github.com/affaan-m/everything-claude-code)
by Affaan Mustafa (MIT), itself inspired by
[lavish-axi](https://github.com/kunchenguid/lavish-axi).

## When to Use

- You wrote a plan or report and need a human decision on it — the canvas
  verdict replaces a typed "yes/proceed".
- The human should *point at* what to change: reviewing designs, comparisons,
  reports, or any local `.md` / `.html` artifact.
- The human wants to edit text directly (select a passage, type the
  replacement) instead of describing the change in prose.

Do NOT use for: code review of diffs, running web apps, or remote URLs. The
canvas serves local artifact files only.

## How It Works

The CLI is called `eddie` below. Pick the first command that works and use
it for every `eddie` in this skill:

1. Installed as a Claude Code plugin: `node "${CLAUDE_SKILL_DIR}/../../eddie.js"`
2. On PATH (`npm install -g github:2dryhands/eddie`): `eddie`
3. Anything else (Node.js ≥ 18): `npx -y github:2dryhands/eddie`

It manages a detached loopback server
(`127.0.0.1:4519` by default) shared by all sessions, keyed by artifact file
path — no session ids to track.

```bash
# 1. Open the artifact in the human's browser (returns immediately)
eddie open plan.md

# 2. Block until the human responds. Run this in the background — it can
#    wait indefinitely. Re-run if interrupted; queued feedback is never lost.
eddie await plan.md
```

Add `open --no-open` when driving Eddie headless (automated tests, CI, or a
scripted verification pass) to skip launching a real browser window.

Re-running `open` on a page that a browser tab already shows does not launch a
duplicate: it reports `"browser": "already open"` and, on macOS with Chrome,
brings that tab to the front. Pass `--new-tab` to launch one anyway.

`await` prints JSON when the human acts:

```json
{
  "status": "feedback",
  "items": [
    { "id": "fb-1", "kind": "annotation", "text": "Split this into two phases",
      "anchor": { "selector": "h2:nth-of-type(3)", "tag": "h2", "snippet": "Phase 2: Migration" } },
    { "id": "fb-2", "kind": "verdict", "verdict": "request-changes" }
  ]
}
```

**3. Address every item, edit the artifact file directly** (the canvas
live-reloads on save — never re-run `open` to refresh), **then resolve and
keep listening in one call**:

```bash
eddie await plan.md \
  --reply "Split Phase 2 as requested, see updated section 3" \
  --resolve "fb-1:done:Split into 3a/3b"
```

**4. End** when review concludes: `eddie end plan.md`.

## Feedback Kinds

- `kind: "chat"` — freeform message. Answer with `--reply` (shows up in the
  canvas chat), not in the terminal.
- `kind: "annotation"` — feedback anchored to an element (`anchor.selector`,
  `anchor.snippet` show what they pointed at; `anchor.textRange.text` when
  they highlighted a passage instead of clicking a whole block).
  `anchor.page` (2026-11-12) — set when the note came from a sibling page the
  human opened via a link inside the artifact (e.g. `case-study.html`, path
  relative to the artifact's folder): edit THAT file, not the opened one.
  Absent = the opened file. Live edit is off on sibling pages.
- `images` (on `annotation` and `chat`, 2026-11-20) — pictures the human
  pasted, dropped or attached: absolute paths to PNG/JPEG/GIF/WebP files in
  Eddie's state dir (`~/.eddie/images/`). Read each one with your file/image
  tool before acting — it is usually the point of the note ("make it like
  this"). `text` may be empty when the picture says it all.
- `kind: "edit"` — the human selected text and typed a replacement. Carries
  `edit.before` and `edit.after`. Apply it to the artifact file as an
  **exact text replacement** of `before` with `after` — do not paraphrase,
  reformat, or "improve" it beyond what they typed. The server never sends
  a no-op edit (identical before/after is rejected upstream), so every
  `edit` item is a real change to make.
- `kind: "verdict"` — `approve` (the chrome's **Ship it** button) is final
  acceptance: the artifact is CONFIRMED. Commit/push the accepted work per
  your project's git rules, report back, and run `eddie end <file>` to close
  the session — don't just stop polling and wait. `request-changes` is no
  longer a chrome button (the canvas only ships Send / Ship it), but it
  remains valid protocol input — other clients or older flows may still send
  it — and simply means "revise and keep listening." A verdict is never
  itself a task — it doesn't need `--resolve`.
- `kind: "rating"` — a design score from the strip above the document:
  `score` (integer 1–10, 10 = top), `subject` (the variant on screen, from
  `<html data-eddie-subject="…">`, else the file name), `comment`, `file`,
  `skill`, `prompt`, `ts`. `skill`/`prompt` are what the page declared it was
  built with — `<meta name="eddie:design-skill" content="…">` and
  `<meta name="eddie:design-prompt" content="…">`, or per variant via
  `data-eddie-skill` / `data-eddie-prompt` on `<html>` — and `null` when it
  declared nothing. The strip shows the skill as a chip (click → the full
  prompt), or an orange "not declared" chip, so the reviewer knows what they
  are scoring. The server has already appended it to the taste journal
  (`EDDIE_RATINGS`, default `~/.eddie/ratings.jsonl`), so
  don't log it again. Not a task — no `--resolve`; act on the comment if
  it asks for something.

## Tasks Lifecycle

Every `chat`, `annotation`, and `edit` item becomes a task in the canvas
(visible to the human as pending, then resolved). **Every task you address
must be closed with `--resolve "<id>:<status>:<note>"`** before — or in the
same call as — your next `await`. Repeat `--resolve` for multiple tasks in
one call. Statuses, used honestly:

- `done` — you made the change (edit applied, annotation acted on).
- `answered` — a chat question was answered in the reply/canvas, no file
  change was needed.
- `declined` — you chose not to act on it. Say why in the note; never
  silently drop feedback.

Leaving a task at `sent` (unresolved) after you've already replied is a
signal the human will notice — it reads as "the agent ignored this." Resolve
before moving on, not "eventually."

## Diagrams (Mermaid)

Fenced ` ```mermaid ` blocks in `.md` artifacts render as themed diagrams the
human can point at — use them for flows, architecture, sequences, state
machines, ER models, or dependency graphs instead of ASCII art. Mermaid loads
from a pinned CDN in the browser; if that's unavailable (offline/air-gapped),
the block degrades to showing its source, so review is never blocked.

## Artifact Requirements for Agents

These apply to every artifact you open in Eddie, on every revision:

- **"What to check in this update" callout at the top** — a short, visible
  block listing what's new, what was fixed since the last round, and what to
  look at. Update it every revision; stale items move to a "known
  limitations" line or get dropped once resolved.
- **No auto-refresh.** Never add `<meta http-equiv="refresh">` or
  equivalent — it resets scroll position and interrupts the human mid-review.
  Eddie already live-reloads on file save; a manual refresh is redundant and
  the meta-refresh actively hurts.
- **Baseline first in comparisons.** Any before/after, A/B, or multi-variant
  comparison puts the original/baseline first, with a legend and a one-line
  methodology note (what's compared, over what period, from what source).
- **Change highlighting works by tag, not by file type.** Eddie diffs
  rendered `p, h1–h6, li, td, th, pre, blockquote` blocks against the
  last-seen baseline and flags what changed. Markdown artifacts always
  render through these tags, so they always get it for free. Hand-authored
  `.html` artifacts only get it when their content actually uses these
  standard text tags — a `<div>`-heavy layout (custom cards, flex/grid
  dashboards) has nothing for the block-level diff to match, so those
  artifacts need you to visually flag what changed yourself (a "changed"
  class/badge, a highlighted border, an inline note) on every revision.
- **Typed text survives your rebuilds.** Text the human types into the
  page's own `<textarea>` / text `<input>` but hasn't sent is restored after
  every reload, caret included. Keep it attached to the right place: give
  the field an `id`, or put it inside a card with a stable `id` or
  `data-to`; otherwise it is matched by position. After your page sends the
  text, clear the field (`ta.value = ''` or `form.reset()`) — that is what
  tells Eddie the draft is gone; replacing the field with a fresh element
  does not, and the sent text would come back on the next reload. A field
  the new build no longer has is skipped; if you change a field's own
  prefilled text, yours wins over the human's old draft.

## Rules

- Markdown artifacts render in Eddie's built-in renderer (Mermaid included);
  `.html` artifacts render as-is with the annotation layer injected via a
  sandboxed iframe.
- Edit the artifact file to revise — the canvas live-reloads on save. Never
  re-run `open` to refresh a session that's already active.
- `{"status": "ended", "endedBy": "user"}` (or `sessionEnded: true` on a
  feedback batch) means the human closed the review from the browser: stop
  polling, deliver any remaining updates in chat, and do not reopen. A plain
  `open` on that session is refused; pass `--reopen` only when the human
  explicitly asks to resume.
- After *you* `end` a session, the human's tab stays usable: a note they send
  there reopens the page and waits for the next `await` (or whoever picks the
  page up). The closing agent's own `await` still gets `ended`.
- Sibling assets (images, CSS) must sit next to the artifact and be
  referenced by a relative path confined to the artifact's directory.
- The server is loopback-only (`127.0.0.1`, host-header gated against DNS
  rebinding) and exits after an idle timeout; `eddie stop` shuts it down
  explicitly. State lives under `~/.eddie` (`EDDIE_STATE_DIR` to override).

## Examples

**Plan approval flow:**

```bash
eddie open plan.md
eddie await plan.md
# → {"status":"feedback","items":[{"id":"fb-1","kind":"verdict","verdict":"approve"}]}
eddie end plan.md
# plan is confirmed — begin implementation
```

**Revision loop** — feedback arrives, you edit the file, resolve, reply, and
keep listening:

```bash
# await returned an edit item fb-3 and an annotation fb-4 → apply the exact
# before→after replacement, act on the annotation, save the file
eddie await plan.md \
  --resolve "fb-3:done:" \
  --resolve "fb-4:done:Reworked the risk table" \
  --reply "Applied your edit and reworked the risk table."
# → blocks again until the next response
```

## Anti-Patterns

- Polling with `--timeout-ms` in a loop — it exists for tests/debugging.
  Leave the plain `await` running instead (in the background).
- Reopening after a user-initiated end "just to show" something.
- Pasting the whole artifact into chat *and* opening a canvas — pick the
  canvas and keep the terminal summary to one line.
- Leaving tasks unresolved after you've replied — every addressed item gets
  a `--resolve` call with an honest status, not just a chat reply.
- Paraphrasing an `edit` item instead of applying `before → after` verbatim.
