/**
 * i18n integrity gate.
 *
 * Two failures this catches, both of which are silent at runtime and invisible to
 * tsc — i18next renders the raw key when it cannot resolve one, so a broken key
 * looks like a screen full of dotted identifiers rather than a crash:
 *
 *   1. UNRESOLVED KEYS — a `t('…')` call, or a key stored in a lookup map, whose
 *      key no longer exists in en.json. Renaming a key and missing one call site
 *      is the normal way this happens.
 *   2. LOCALE DRIFT — en/es/it holding different key sets. Before the trilingual
 *      pass es was missing 99 keys and it 100, and nothing ever said so.
 *
 * Scope note: this checks KEY INTEGRITY only. It deliberately does not police
 * hardcoded English (the language picker's endonyms and the brand name in
 * +html.tsx are correct as literals) and it does not compare VALUES between
 * locales — `common.playlist`, `common.podcast`, `search.resultCount`,
 * `seo.siteName` and `settings.create.studio` are identical in all three on
 * purpose, being loanwords, a format string and brand names.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const LOCALES = ['en', 'es', 'it'];
const SOURCE_DIRS = ['app', 'components', 'lib', 'hooks', 'utils', 'stores', 'services'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

function flatten(object, prefix = '') {
  const flat = {};
  for (const [key, value] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(flat, flatten(value, path));
    } else {
      flat[path] = value;
    }
  }
  return flat;
}

function loadLocale(code) {
  return flatten(JSON.parse(readFileSync(join(ROOT, 'locales', `${code}.json`), 'utf8')));
}

function sourceFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
        found.push(path);
      }
    }
  };
  for (const dir of SOURCE_DIRS) {
    const path = join(ROOT, dir);
    try {
      if (statSync(path).isDirectory()) walk(path);
    } catch {
      // A source dir that does not exist is not an error; the app may not have it.
    }
  }
  return found;
}

/**
 * i18next resolves `key` when the key exists, or when it is a plural whose forms
 * are stored as `key_one` / `key_other`.
 */
function resolves(key, catalogue) {
  return key in catalogue || `${key}_other` in catalogue;
}

const catalogues = Object.fromEntries(LOCALES.map((code) => [code, loadLocale(code)]));
const english = catalogues.en;

// Top-level namespaces, used to recognise keys held in lookup maps rather than
// passed to t() directly — LIBRARY_FILTER_KEYS and SEARCH_SECTION_KEYS exist
// precisely because those strings are identifiers elsewhere, so a rename would
// otherwise break them with nothing watching.
const namespaces = new Set(Object.keys(english).map((key) => key.split('.')[0]));

const T_CALL = /\bt\(\s*'([^']+)'/g;
const TRANS_KEY = /i18nKey\s*=\s*'([^']+)'/g;
const MAPPED_KEY = /'([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)'/g;

const unresolved = [];
// A `t('common.artist')` call matches both the call pattern and the mapped-key
// pattern, so the same site would otherwise be reported twice.
const seen = new Set();

for (const file of sourceFiles()) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const record = (key) => {
      if (resolves(key, english)) return;
      const where = `${relative(ROOT, file)}:${index + 1}:${key}`;
      if (seen.has(where)) return;
      seen.add(where);
      unresolved.push({ file: relative(ROOT, file), line: index + 1, key });
    };
    for (const match of line.matchAll(T_CALL)) record(match[1]);
    for (const match of line.matchAll(TRANS_KEY)) record(match[1]);
    for (const match of line.matchAll(MAPPED_KEY)) {
      // Only strings that begin with a real namespace, so ordinary dotted
      // literals (module paths, mime types, query keys) are never mistaken for keys.
      if (namespaces.has(match[1].split('.')[0])) record(match[1]);
    }
  });
}

const drift = [];
for (const code of LOCALES) {
  if (code === 'en') continue;
  const keys = new Set(Object.keys(catalogues[code]));
  const missing = Object.keys(english).filter((key) => !keys.has(key));
  const extra = Object.keys(catalogues[code]).filter((key) => !(key in english));
  if (missing.length || extra.length) drift.push({ code, missing, extra });
}

let failed = false;

if (unresolved.length) {
  failed = true;
  console.error(`\ni18n: ${unresolved.length} key(s) do not resolve against locales/en.json`);
  console.error('These render as raw dotted identifiers in every language.\n');
  for (const { file, line, key } of unresolved) {
    console.error(`  ${file}:${line}  ${key}`);
  }
}

if (drift.length) {
  failed = true;
  console.error('\ni18n: locale files are out of lockstep with en.json\n');
  for (const { code, missing, extra } of drift) {
    if (missing.length) {
      console.error(`  ${code}.json is missing ${missing.length} key(s) present in en.json:`);
      for (const key of missing) console.error(`    - ${key}`);
    }
    if (extra.length) {
      console.error(`  ${code}.json has ${extra.length} key(s) that en.json does not:`);
      for (const key of extra) console.error(`    + ${key}`);
    }
  }
}

if (failed) {
  console.error('');
  process.exit(1);
}

const total = Object.keys(english).length;
console.log(`i18n ok — ${total} keys, ${LOCALES.join('/')} in lockstep, every referenced key resolves`);
