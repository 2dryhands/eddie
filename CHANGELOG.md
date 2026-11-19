# Changelog

Notable changes to Eddie. Versions follow [Semantic Versioning](https://semver.org/);
while the major version is 0, any minor release may change behaviour.

## [Unreleased]

### Added
- Claude Code plugin: `/plugin install eddie --marketplace 2dryhands/eddie` installs the CLI and the skill in one line.
- CI: `npm test` on Node 18, 20 and 22, Ubuntu and macOS. Browser tests fail the run instead of skipping silently.
- The canvas works on a phone: no sideways scrolling at 390 px; the header wraps below 960 px and the review panel moves under the document below 720 px.

### Changed
- `eddie open` takes the file as the first non-flag argument, so `eddie open --no-open plan.md` works.

## [0.1.15] - 2026-11-18

### Added
- Silent page commands: a page can send a command that reaches the agent but stays out of the reviewer's chat, task list and queue.
- A page can declare itself an app (`<meta name="eddie:app">` plus `eddie:app-icon`); Eddie serves a web manifest, so Chrome can install the page as its own window with its own icon.
- A presence strip under the header shows where a note is: seen, on its way to the agent, being worked on, waiting for your check.
- A live data feed: `<page>.feed.json` next to a page is pushed into it over the event stream.

### Changed
- `localStorage` used by a page is kept on the server, so state survives a reload and a new tab.
- A running server restarts itself on the next CLI call after an upgrade.

## [0.1.10] - 2026-11-18

### Added
- Text typed into a page's own fields (textarea, text inputs) survives a reload, together with focus and caret position.
- Design rating strip (1–10 plus a comment), saved to the file named by `EDDIE_RATINGS`.

### Changed
- `eddie open` brings the page's existing tab to the front instead of opening a duplicate.

### Fixed
- A note sent to a page the agent already closed reopens the page instead of failing in the tab.
- A page closed by the reviewer shows a "Reopen" card; the typed note is kept and sent after reopening.
- "Agent thinking" turns off when the last task is closed, or when nobody picks a note up within 2 minutes.
- Pages that use `localStorage` no longer break inside the sandboxed frame.
- Links from a page open outside the sandbox.
- A server restart invalidates cached pages.

## [0.1.9] - 2026-10-09

### Added
- Checklist in the "what to check" block; Option+arrow keys widen a selection, Shift+click adds blocks.

### Fixed
- Text blocks can be picked again.
- Keys typed into the note card no longer reach the page.

## [0.1.6] - 2026-08-26

### Fixed
- A new canvas always opens, however many are already open. Hidden tabs release their connection, and at most `EDDIE_MAX_STREAMS` (default 4) canvases hold a live feed; a paused canvas says so and resumes on click.
- `/health` reports `streams` and `streamBudget`.

## [0.1.4] - 2026-08-23

### Fixed
- A loading veil instead of a blank white frame; pages are revalidated by ETag.
- On macOS `eddie open` launches Chrome instead of the system default browser.
- Heavy pages no longer render blank in Safari.

## [0.1.3] - 2026-07-31

### Added
- Live text editing: edit an HTML page in place, save to disk, download a clean copy.
- Video and audio next to a page are served with the right content type and HTTP Range support (Safari).

### Fixed
- A blank page frame heals itself, including the Safari case.

## [0.1.0] - 2026-07-20

### Added
- First release, extracted from the `plan-canvas` tool in [everything-claude-code](https://github.com/affaan-m/everything-claude-code).
- `eddie open` / `await` / `end`: the agent opens a `.md` or `.html` file, the reviewer annotates, edits text and sends a verdict, and the agent gets the whole round as one JSON response.
- Feedback items become tasks the agent closes with `--resolve` (`done` / `answered` / `declined`).
- Russian and English interface, picked from the browser language, with a toggle.
- Blocks the agent changed since your last feedback are highlighted.
- The server listens on `127.0.0.1` only and rejects foreign `Host`/`Origin` headers; pages render in a sandboxed iframe.
