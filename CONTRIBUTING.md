# Contributing to Eddie

Bug reports, ideas and pull requests are welcome.

## Reporting a bug

Open an issue with: what you ran, what you expected, what happened, your OS,
browser and Node version. Security problems go through [SECURITY.md](SECURITY.md),
not issues.

## Development

Requirements: Node.js 18 or newer and Google Chrome (the browser tests drive a
real Chrome).

```bash
git clone https://github.com/2dryhands/eddie.git
cd eddie
node eddie.js open README.md   # try it
npm test                       # full suite, ~1–2 minutes
node tests/run-all.js --quick  # unit and server tests only, seconds
```

Chrome is looked up at the default macOS path; elsewhere set
`EDDIE_TEST_CHROME=/path/to/chrome`. Without Chrome the browser tests are
skipped; set `EDDIE_REQUIRE_BROWSER=true` to make that a failure (CI does on Node 22).

## Pull requests

- One change per pull request, with a test that fails without it.
- No runtime dependencies. Eddie runs on the Node standard library only.
- Interface text goes into `lib/i18n.js` in both English and Russian.
- The canvas must work at 390 px wide without sideways scrolling
  (`tests/mobile.test.js`).
- Bumping the version: change `package.json` and `.claude-plugin/plugin.json`
  together (`tests/plugin.test.js` checks this) and add an entry to
  [CHANGELOG.md](CHANGELOG.md).
- `npm test` passes locally; CI runs it on Node 18, 20 and 22, Ubuntu and macOS.

By contributing you agree that your work is released under the [MIT license](LICENSE).
