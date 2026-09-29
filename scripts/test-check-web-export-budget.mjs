#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const CHECK = new URL('./check-web-export-budget.mjs', import.meta.url).pathname;
const INVENTORY = new URL('./write-web-bundle-inventory.mjs', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'syra-web-budget-'));
const dist = join(work, 'dist'), budgetFile = join(work, 'budgets.json'), inventoryFile = join(work, 'inventory.json');
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
mkdirSync(dist);
const limits = { initialJavaScriptBytes: 100, initialJavaScriptGzipBytes: 150, translationBytes: 1000, translationGzipBytes: 1000, otherJavaScriptBytes: 100, otherJavaScriptGzipBytes: 150, nonJavaScriptBytes: 500, fontBytes: 32 };
const setBudget = (changes = {}) => writeFileSync(budgetFile, JSON.stringify({ frontendWeb: { ...limits, ...changes } }));
const run = () => spawnSync(process.execPath, [CHECK, dist, budgetFile, inventoryFile], { encoding: 'utf8' });
const locale = '/node_modules/@oxy.so/bloom/lib/module/locale/translations/ru.js';
function fixture({ entry = 'globalThis.value = 1;', entrySource = '/app/index.ts', languageSource = locale } = {}) {
  writeFileSync(join(dist, 'index.html'), '<script src="/entry.js" defer></script>');
  writeFileSync(join(dist, 'icons.ttf'), Buffer.alloc(16));
  for (const [name, code, source] of [['entry.js', entry, entrySource], ['ru-abcd.js', 'globalThis.translation = "Русский 日本語 العربية";', languageSource]]) {
    writeFileSync(join(dist, name), code + '\n//# sourceMappingURL=' + name + '.map\n//# debugId=fixture\n');
    writeFileSync(join(dist, `${name}.map`), JSON.stringify({ sources: [source] }));
  }
  const result = spawnSync(process.execPath, [INVENTORY, dist, inventoryFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(dist, 'entry.js.map')), false, 'maps must not ship');
}
fixture(); setBudget(); assert.equal(run().status, 0, 'valid partitioned export');
setBudget({ fontBytes: 8 }); assert.match(run().stderr, /fontBytes/, 'font growth fails');
fixture({ entry: 'globalThis.value = "' + 'x'.repeat(140) + '";' }); setBudget();
assert.match(run().stderr, /initialJavaScriptBytes/, 'initial growth fails even with spare translation capacity');
fixture({ entry: 'globalThis.value = "' + 'x'.repeat(140) + '";', entrySource: locale });
assert.match(run().stderr, /initialJavaScriptBytes/, 'an eagerly loaded locale remains initial code');
fixture({ languageSource: '/app/secretly-large-route.tsx' }); setBudget({ otherJavaScriptBytes: 0 });
assert.match(run().stderr, /otherJavaScriptBytes/, 'a language-like filename cannot exempt application code');
fixture(); setBudget(); writeFileSync(join(dist, 'entry.js'), 'changedAfterInventory();');
assert.match(run().stderr, /stale source-map inventory/, 'stale provenance fails');
fixture(); writeFileSync(join(dist, 'index.html'), '<div>No scripts</div>');
assert.match(run().stderr, /No initial script/, 'missing entry cannot report zero initial bytes');
console.log('Web-export budget mutations detected: initial, locale provenance, stale inventory and assets.');
