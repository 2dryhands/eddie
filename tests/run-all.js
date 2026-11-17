'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
// HEAVY: live CLI processes and a real Chrome — ~90% of the wall time, balloons under load.
// `--quick` (smoke.py / quick verify) skips them; plain `npm test` (verify --full) runs everything.
const HEAVY = ['e2e.test.js', 'socket-budget.test.js', 'drafts.test.js', 'closed-page.test.js'];
const quick = process.argv.includes('--quick');
const files = ['i18n.test.js', 'sessions.test.js', 'markdown.test.js', 'server.test.js', ...(quick ? [] : HEAVY)];
let failed = false;
for (const file of files) {
  console.log(`\n== ${file} ==`);
  const res = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8' });
  process.stdout.write(res.stdout || '');
  process.stderr.write(res.stderr || '');
  if (res.status !== 0 || /✗/.test(res.stdout)) failed = true;
}
process.exit(failed ? 1 : 0);
