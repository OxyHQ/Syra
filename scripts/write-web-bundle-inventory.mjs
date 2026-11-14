import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
const dist = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(resolve(dir, entry.name)) : [resolve(dir, entry.name)],
  );
// oxy-web-pwa (@oxy.so/app-preset) writes these service-worker files after
// the export. They are not Metro output, so they ship without a source map;
// any other script without one still fails here.
const UNMAPPED_WORKER_FILES = new Set(['sw.js', 'oxy-sw-base.js', 'oxy-sw-register.js']);
const inventory = {};
for (const file of walk(dist).filter((file) => file.endsWith('.js'))) {
  const mapFile = `${file}.map`;
  if (UNMAPPED_WORKER_FILES.has(relative(dist, file)) && !existsSync(mapFile)) {
    const code = readFileSync(file);
    inventory[relative(dist, file)] = {
      sha256: createHash('sha256').update(code).digest('hex'),
      translation: false,
    };
    continue;
  }
  const map = JSON.parse(readFileSync(mapFile, 'utf8'));
  // Expo SDK 58's Metro writes indexed source maps (`sections`, each with its
  // own `map`); earlier SDKs wrote a flat map with `sources` at the top level.
  const sources = map.sections
    ? map.sections.flatMap((section) => section.map?.sources ?? [])
    : map.sources;
  const translation =
    sources.length > 0 &&
    sources.every((source) =>
      /^\/node_modules\/@oxy\.so\/bloom\/lib\/module\/locale\/translations\/(ar|bn|ca|de|es|fr|hi|id|it|ja|pt|ru|tr|zh)\.js$/.test(
        source,
      ),
    );
  // Source maps are build evidence, not public deployment assets.
  const code = readFileSync(file, 'utf8').replace(
    /^\/\/# (?:sourceMappingURL|debugId)=.*\r?\n?/gm,
    '',
  );
  writeFileSync(file, code);
  inventory[relative(dist, file)] = {
    sha256: createHash('sha256').update(code).digest('hex'),
    translation,
  };
  unlinkSync(mapFile);
}
for (const file of walk(dist).filter((file) => file.endsWith('.map'))) unlinkSync(file);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(inventory, null, 2) + '\n');
