import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
const dist = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(resolve(dir, entry.name)) : [resolve(dir, entry.name)]);
const inventory = {};
for (const file of walk(dist).filter((file) => file.endsWith('.js'))) {
  const mapFile = `${file}.map`;
  const map = JSON.parse(readFileSync(mapFile, 'utf8'));
  const translation = map.sources.length > 0 && map.sources.every((source) =>
    /^\/node_modules\/@oxy\.so\/bloom\/lib\/module\/locale\/translations\/(ar|bn|ca|de|es|fr|hi|id|it|ja|pt|ru|tr|zh)\.js$/.test(source));
  // Source maps are build evidence, not public deployment assets.
  const code = readFileSync(file, 'utf8').replace(/^\/\/# (?:sourceMappingURL|debugId)=.*\r?\n?/gm, '');
  writeFileSync(file, code);
  inventory[relative(dist, file)] = { sha256: createHash('sha256').update(code).digest('hex'), translation };
  unlinkSync(mapFile);
}
for (const file of walk(dist).filter((file) => file.endsWith('.map'))) unlinkSync(file);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(inventory, null, 2) + '\n');
