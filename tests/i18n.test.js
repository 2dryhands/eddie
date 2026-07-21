'use strict';
const assert = require('assert');
const { DICTS } = require('../lib/i18n');
const en = Object.keys(DICTS.en).sort(), ru = Object.keys(DICTS.ru).sort();
assert.deepStrictEqual(ru, en, 'ru/en key sets must match');
for (const lang of ['en', 'ru']) for (const [k, v] of Object.entries(DICTS[lang]))
  assert.ok(typeof v === 'string' && v.trim(), `${lang}.${k} is empty`);
assert.ok(en.length >= 30, 'dictionary suspiciously small');
console.log('  ✓ i18n dictionaries in sync (' + en.length + ' keys)');
