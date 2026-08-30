#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CHECK = new URL('./check-frontend-bundle-imports.mjs', import.meta.url).pathname;
const fixture = mkdtempSync(join(tmpdir(), 'syra-bundle-imports-'));
process.on('exit', () => rmSync(fixture, { recursive: true, force: true }));
const run = () => spawnSync(process.execPath, [CHECK, fixture], { encoding: 'utf8' });

mkdirSync(join(fixture, 'components'));
writeFileSync(join(fixture, 'components', 'Good.tsx'), "import Ionicons from '@expo/vector-icons/Ionicons';\n");
writeFileSync(join(fixture, 'components', 'Harmless.ts'), `
// import { Ionicons } from '@expo/vector-icons';
/* const icons = require('@expo/vector-icons'); */
const example = "import { Ionicons } from '@expo/vector-icons';";
const description = "Use import('@expo/vector-icons') only in this documentation string.";
`);
const clean = run();
if (clean.status !== 0) {
  console.error(`FAIL: direct family imports, comments, or strings were rejected\n${clean.stdout}${clean.stderr}`);
  process.exit(1);
}

writeFileSync(join(fixture, 'components', 'Static.tsx'), "import { Ionicons } from '@expo/vector-icons';\n");
writeFileSync(join(fixture, 'components', 'CommonJs.ts'), "const icons = require('@expo/vector-icons');\n");
writeFileSync(join(fixture, 'components', 'Dynamic.ts'), "const icons = import('@expo/vector-icons');\n");
const broken = run();
const expectedViolations = [
  'components/Static.tsx:1',
  'components/CommonJs.ts:1',
  'components/Dynamic.ts:1',
];
if (broken.status !== 1 || !expectedViolations.every((violation) => broken.stderr.includes(violation))) {
  console.error(`FAIL: root-barrel import escaped the gate\n${broken.stdout}${broken.stderr}`);
  process.exit(1);
}
console.log('Bundle-import gate mutations detected.');
