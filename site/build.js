#!/usr/bin/env node
'use strict';
// Builds the static landing for GitHub Pages: site/index.html plus a playable
// demo made from the real canvas (lib/ui.js + lib/sdk.js) with the server
// swapped for site/demo-shim.js. Usage: node site/build.js [outDir]
const fs = require('fs');
const path = require('path');
const { renderCanvasHtml, canvasCss, canvasClientJs } = require('../lib/ui');
const { artifactSdkJs } = require('../lib/sdk');
const { injectSdk } = require('../lib/server');
const { version } = require('../package.json');

const here = __dirname;
const out = path.resolve(process.argv[2] || path.join(here, '_build'));
const KEY = 'de300de300de';

// Swap an exact piece of generated code; a silent miss would ship a broken demo.
function swap(text, from, to, what) {
  if (!text.includes(from)) throw new Error(`site/build.js: ${what} not found — lib/ changed, update the build`);
  return text.split(from).join(to);
}

const session = {
  key: KEY,
  file: 'demo-plan.html',
  status: 'open',
  chat: [{ role: 'agent', kind: 'chat', at: new Date().toISOString(),
    text: 'Draft pricing plan is ready. Click anything to leave a note, double-click text to edit, then press Send or Ship it.' }],
  tasks: []
};

let canvas = renderCanvasHtml(session, { clientPath: 'client.js', cssPath: 'canvas.css', version });
canvas = swap(canvas, `"/artifact/${KEY}/"`, `"artifact/${KEY}/"`, 'artifact iframe src'); // Pages serves under /<repo>/
// The design-score strip is an in-house feature; a visitor would read it as an error.
canvas = swap(canvas, '<link rel="stylesheet"', '<meta name="robots" content="noindex">\n<style>#rateBar{display:none!important}</style>\n<link rel="stylesheet"', 'stylesheet link');

let artifact = injectSdk(fs.readFileSync(path.join(here, 'demo-plan.html'), 'utf8'));
artifact = swap(artifact, '<script src="/sdk.js">', '<script src="../../sdk.js">', 'sdk tag');

// The SDK reads its page name off the server path /artifact/<key>/; on Pages
// the path has a prefix, so let the pattern skip it.
// The clean download strips the injected SDK tag, which here has a relative src.
let sdk = swap(artifactSdkJs(), 'location.pathname.replace(/^\\/artifact\\/', 'location.pathname.replace(/^.*\\/artifact\\/', 'sdk page pattern');
sdk = swap(sdk, 'script[src="/sdk.js"]', 'script[src="../../sdk.js"]', 'sdk clean-copy selector');

const files = {
  'index.html': fs.readFileSync(path.join(here, 'index.html'), 'utf8'),
  'demo/index.html': canvas,
  'demo/canvas.css': canvasCss(),
  'demo/client.js': fs.readFileSync(path.join(here, 'demo-shim.js'), 'utf8') + '\n' + canvasClientJs(),
  'demo/sdk.js': sdk,
  [`demo/artifact/${KEY}/index.html`]: artifact,
  '.nojekyll': ''
};
for (const [rel, body] of Object.entries(files)) {
  const file = path.join(out, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
console.log(`site built: ${out} (${Object.keys(files).length} files, eddie ${version})`);
