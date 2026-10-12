#!/usr/bin/env bun

/**
 * Mutation-tests `check-bun-pin.mjs`.
 *
 * A pin gate fails QUIET in every interesting way: a regex that stops matching
 * the image line reports "no mismatch", and so does a Dockerfile rewritten to a
 * form the gate does not parse. Each case below breaks exactly one thing and
 * requires the gate to fail for that reason; the passing cases pin the forms
 * Syra actually uses, so a later tightening cannot reject them by accident.
 *
 * Fixtures are real trees with a real `git init`, so the gate's actual file
 * listing runs rather than a stand-in for it.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkBunPin } from './check-bun-pin.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;

function report(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

const PIN = '1.4.3';
/** Dockerfile and Actions interpolations, spelled as text rather than JS templates. */
const DOCKER_BUN_VERSION = '$' + '{BUN_VERSION}';
const ACTIONS_ENV_BUN_VERSION = '$' + '{{ env.BUN_VERSION }}';
/** `null` writes a package.json with no `packageManager` at all. */
const pkg = (packageManager = `bun@${PIN}`) =>
  JSON.stringify(
    packageManager === null ? { name: 'fixture' } : { name: 'fixture', packageManager },
  );
const copyImage = (tag = `${PIN}-alpine`) =>
  `FROM node:22.23-alpine AS base\nCOPY --from=oven/bun:${tag} /usr/local/bin/bun /usr/local/bin/bun\n`;
const workflow = (withBlock = 'bun-version-file: package.json', env = '') =>
  `name: ci\non: [push]\n${env}jobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n      - uses: oven-sh/setup-bun@v2\n${withBlock ? `        with:\n          ${withBlock}\n` : ''}      - run: bun install --frozen-lockfile\n`;

/** Build a scratch checkout and run the REAL gate against it. */
function runAgainst(files) {
  const root = mkdtempSync(join(tmpdir(), 'bun-pin-'));
  try {
    const tree = {
      'package.json': pkg(),
      'packages/backend/Dockerfile': copyImage(),
      '.github/workflows/ci.yml': workflow(),
      ...files,
    };
    for (const [path, contents] of Object.entries(tree)) {
      if (contents === null) continue;
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    try {
      return { result: checkBunPin({ root }) };
    } catch (error) {
      return { error };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The gate must fail, and its message must match `pattern`. */
function expectFailure(name, files, pattern) {
  const { result, error } = runAgainst(files);
  const messages = error ? [error.message] : (result?.failures ?? []);
  report(
    name,
    messages.length > 0 && messages.some((m) => pattern.test(m)),
    messages.length ? messages.join('; ') : 'the gate returned success',
  );
}

function expectPass(name, files) {
  const { result, error } = runAgainst(files);
  report(
    name,
    !error && result?.failures.length === 0,
    error ? error.message : result?.failures.join('; '),
  );
}

console.log('check-bun-pin self-test\n');

// --- the pin itself ---------------------------------------------------------

expectPass('control: a pinned tree with a matching image and workflow passes', {});
expectFailure(
  'a missing packageManager fails',
  { 'package.json': pkg(null) },
  /must pin `packageManager`/,
);
expectFailure(
  'a packageManager range fails',
  { 'package.json': pkg('bun@^1.4.3') },
  /must pin `packageManager`/,
);
expectFailure(
  'a non-bun packageManager fails',
  { 'package.json': pkg('npm@10.9.0') },
  /must pin `packageManager`/,
);

// --- the image ---------------------------------------------------------------

expectFailure(
  'packageManager moved without the image fails',
  { 'package.json': pkg('bun@1.4.4') },
  /oven\/bun:1\.4\.3-alpine.*pins bun@1\.4\.4/,
);
expectFailure(
  'a COPY --from at another bun fails',
  { 'packages/backend/Dockerfile': copyImage('1.4.2-alpine') },
  /runs bun 1\.4\.2-alpine/,
);
expectFailure(
  'a FROM stage at another bun fails',
  { 'packages/backend/Dockerfile': `${copyImage()}FROM oven/bun:1.3.14-alpine AS runner\n` },
  /runs bun 1\.3\.14-alpine/,
);
expectFailure(
  'a FROM behind --platform is still read',
  { 'packages/backend/Dockerfile': 'FROM --platform=$BUILDPLATFORM oven/bun:1.5.0 AS builder\n' },
  /runs bun 1\.5\.0/,
);
expectFailure(
  'an untagged oven/bun (latest) fails',
  { 'packages/backend/Dockerfile': 'FROM oven/bun AS builder\n' },
  /runs bun latest/,
);
expectFailure(
  'a floating tag fails',
  { 'packages/backend/Dockerfile': 'FROM oven/bun:alpine\n' },
  /runs bun alpine/,
);
expectFailure(
  'a minor-only tag fails',
  { 'packages/backend/Dockerfile': 'FROM oven/bun:1.4\n' },
  /runs bun 1\.4/,
);
expectFailure(
  'an ARG BUN_VERSION default at another bun fails',
  {
    'packages/backend/Dockerfile': `ARG BUN_VERSION=1.4.2\nFROM oven/bun:${DOCKER_BUN_VERSION}-alpine\n`,
  },
  /pins bun@1\.4\.3/,
);
expectPass('an ARG BUN_VERSION default equal to the pin, interpolated into the tag, passes', {
  'packages/backend/Dockerfile': `ARG BUN_VERSION=${PIN}\nFROM oven/bun:${DOCKER_BUN_VERSION}-alpine AS builder\n`,
});
expectFailure(
  'a tag variable with no default fails',
  {
    'packages/backend/Dockerfile': `ARG BUN_VERSION\nFROM oven/bun:${DOCKER_BUN_VERSION}-alpine\n`,
  },
  /no default/,
);
expectFailure(
  'a mismatched image in a SECOND Dockerfile is found',
  { 'packages/worker/Dockerfile.worker': 'FROM oven/bun:1.4.1-slim\n' },
  /packages\/worker\/Dockerfile\.worker/,
);
expectPass('a commented-out FROM at another bun is not a stage', {
  'packages/backend/Dockerfile': `# FROM oven/bun:1.0.0\n${copyImage()}`,
});
expectPass('a COPY --from split over a continuation line is read', {
  'packages/backend/Dockerfile': `FROM node:22.23-alpine\nCOPY --from=oven/bun:${PIN}-alpine \\\n  /usr/local/bin/bun /usr/local/bin/bun\n`,
});
expectFailure(
  'floor: no oven/bun reference at all fails',
  {
    'packages/backend/Dockerfile':
      'FROM node:22.23-alpine\n# COPY --from=oven/bun:1.4.3-alpine /usr/local/bin/bun /usr/local/bin/bun\n',
  },
  /found NO `oven\/bun` reference/,
);
expectFailure(
  'floor: no Dockerfile at all fails',
  { 'packages/backend/Dockerfile': null },
  /found NO `oven\/bun` reference/,
);
expectPass('a .dockerignore named like a Dockerfile is not read as one', {
  'packages/backend/Dockerfile.dockerignore': 'FROM oven/bun:0.0.1\n',
});

// --- the workflows -----------------------------------------------------------

expectFailure(
  'a setup-bun step with no version fails',
  { '.github/workflows/ci.yml': workflow('') },
  /without a version/,
);
expectFailure(
  'a literal bun-version at another bun fails',
  { '.github/workflows/ci.yml': workflow("bun-version: '1.4.2'") },
  /bun-version is 1\.4\.2/,
);
expectPass('a literal bun-version equal to the pin passes', {
  '.github/workflows/ci.yml': workflow(`bun-version: ${PIN}`),
});
expectFailure(
  'a bun-version-file other than package.json fails',
  { '.github/workflows/ci.yml': workflow('bun-version-file: .bun-version') },
  /file \.bun-version/,
);
expectFailure(
  'a workflow BUN_VERSION env at another bun fails',
  {
    '.github/workflows/ci.yml': workflow(
      `bun-version: ${ACTIONS_ENV_BUN_VERSION}`,
      "env:\n  BUN_VERSION: '1.4.2'\n",
    ),
  },
  /env BUN_VERSION is 1\.4\.2/,
);
expectPass('a workflow BUN_VERSION env equal to the pin passes', {
  '.github/workflows/ci.yml': workflow(
    `bun-version: ${ACTIONS_ENV_BUN_VERSION}`,
    `env:\n  BUN_VERSION: '${PIN}'\n`,
  ),
});

// --- the real repository ----------------------------------------------------

{
  let outcome;
  try {
    outcome = { result: checkBunPin({ root: repositoryRoot }) };
  } catch (error) {
    outcome = { error };
  }
  report(
    'the real repository holds every bun to its pin',
    !outcome.error && outcome.result.failures.length === 0 && outcome.result.imageReferences > 0,
    outcome.error ? outcome.error.message : outcome.result.failures.join('\n       '),
  );
}

console.log('');
if (failed > 0) {
  console.error(`${failed} self-test case(s) FAILED.`);
  process.exit(1);
}
console.log('All self-test cases passed.');
