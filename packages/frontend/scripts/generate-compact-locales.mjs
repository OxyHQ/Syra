import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(frontend, 'locales');
const output = join(source, 'compact');
const base = JSON.parse(readFileSync(join(source, 'en.json'), 'utf8'));
const check = process.argv.includes('--check');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function patch(baseValue, value) {
  if (JSON.stringify(baseValue) === JSON.stringify(value)) return [0];
  if (
    record(baseValue) &&
    record(value) &&
    JSON.stringify(Object.keys(baseValue)) === JSON.stringify(Object.keys(value))
  ) {
    const changes = {};
    for (const key of Object.keys(value)) {
      const child = patch(baseValue[key], value[key]);
      if (child[0] !== 0) Object.defineProperty(changes, key, { value: child, enumerable: true });
    }
    return [2, changes];
  }
  return [1, value];
}

const files = readdirSync(source)
  .filter((name) => name.endsWith('.json') && name !== 'en.json')
  .sort();
if (!check) mkdirSync(output, { recursive: true });
const existing = readdirSync(output)
  .filter((name) => name.endsWith('.json'))
  .sort();
const generated = files.map((name) => name.replace(/\.json$/, '.generated.json'));
if (check && JSON.stringify(existing) !== JSON.stringify(generated)) {
  throw new Error('Compact locale files differ from source locales; regenerate them.');
}
for (const name of files) {
  const value = JSON.parse(readFileSync(join(source, name), 'utf8'));
  const content = `${JSON.stringify(patch(base, value))}\n`;
  const target = join(output, name.replace(/\.json$/, '.generated.json'));
  if (check) {
    if (readFileSync(target, 'utf8') !== content)
      throw new Error(`${name} compact locale is stale`);
  } else writeFileSync(target, content);
}
console.log(`${check ? 'Verified' : 'Generated'} ${files.length} compact locales.`);
