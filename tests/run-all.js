'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const files = ['sessions.test.js', 'markdown.test.js', 'server.test.js', 'e2e.test.js'];
let failed = false;
for (const file of files) {
  console.log(`\n== ${file} ==`);
  const res = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8' });
  process.stdout.write(res.stdout || '');
  process.stderr.write(res.stderr || '');
  if (res.status !== 0 || /✗/.test(res.stdout)) failed = true;
}
process.exit(failed ? 1 : 0);
