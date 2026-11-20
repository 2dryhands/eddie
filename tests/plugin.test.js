'use strict';
// The Claude Code plugin ships the repo itself: the manifests must agree with
// package.json, or `/plugin update` never sees a new version.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const pkg = read('package.json'), plugin = read('.claude-plugin/plugin.json'), market = read('.claude-plugin/marketplace.json');
assert.strictEqual(plugin.version, pkg.version, 'plugin.json version must match package.json');
const entry = market.plugins.find(p => p.name === plugin.name);
assert.ok(entry && entry.source === './', 'marketplace lists the plugin from the repo root');
const skill = fs.readFileSync(path.join(root, 'skills/eddie/SKILL.md'), 'utf8');
assert.ok(/^name: eddie$/m.test(skill), 'skill frontmatter names it eddie');
assert.ok(skill.includes('${CLAUDE_SKILL_DIR}/../../eddie.js') && fs.existsSync(path.join(root, 'eddie.js')),
  'skill points at eddie.js two levels up from its folder');
const hook = read('hooks/hooks.json').hooks.PermissionRequest.find(h => h.matcher === 'ExitPlanMode');
assert.ok(hook && /\$\{CLAUDE_PLUGIN_ROOT\}\/eddie\.js" plan-hook$/.test(hook.hooks[0].command),
  'plan mode hook runs eddie.js plan-hook from the plugin root');
assert.ok(pkg.files.includes('hooks/'), 'npm package ships hooks/');
console.log('  ✓ plan mode hook: ExitPlanMode → eddie.js plan-hook');
console.log('  ✓ plugin manifests agree with package.json (' + pkg.version + ')');
