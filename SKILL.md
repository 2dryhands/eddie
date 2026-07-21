---
name: eddie
description: Open plans and Markdown/HTML artifacts in a local browser canvas where a human annotates elements, edits text inline, chats, and delivers an Approve / Request changes verdict — while the agent blocks on a single CLI call that returns their feedback as structured JSON. Use when presenting a plan or report for review, when feedback is easier pointed at than typed, or when the human wants to edit text directly and have the agent apply the exact change.
metadata:
  origin: eddie
version: "1.0.0"
---

# Eddie

Review loop for plans and local artifacts: you write the artifact, the human
reviews it in the browser — annotating the exact element they mean, editing
text inline, chatting, and delivering an **Approve / Request changes**
verdict — while you block on a single CLI call that returns their feedback
as JSON.

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

The CLI binary is `eddie` (`node eddie.js` if running from a clone that
hasn't been linked). It manages a detached loopback server
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
- `kind: "edit"` — the human selected text and typed a replacement. Carries
  `edit.before` and `edit.after`. Apply it to the artifact file as an
  **exact text replacement** of `before` with `after` — do not paraphrase,
  reformat, or "improve" it beyond what they typed. The server never sends
  a no-op edit (identical before/after is rejected upstream), so every
  `edit` item is a real change to make.
- `kind: "verdict"` — `approve` means the artifact is CONFIRMED: stop
  polling, run `eddie end <file>`, and move on (start implementing, ship the
  report, etc.). `request-changes` means keep revising and keep the loop
  going. A verdict is never itself a task — it doesn't need `--resolve`.

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
