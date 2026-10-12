#!/usr/bin/env bun

/**
 * One bun, named once: root `package.json` `packageManager: "bun@x.y.z"`.
 *
 * ## Why a gate
 *
 * `bun install --frozen-lockfile` is only as reproducible as the bun running
 * it. Before this, Syra named its bun in five places that nothing compared: a
 * literal `bun-version` in each of four workflows and the backend image's
 * `COPY --from=oven/bun:<tag>`. A bump that missed one built that path with a
 * bun nobody tested, and the frozen install either failed mid-deploy or passed
 * on the wrong bun. Now every workflow reads the pin
 * (`bun-version-file: package.json`), and this gate holds every place that
 * still has to be a literal to the same version.
 *
 * ## What it checks
 *
 *   1. `packageManager` is exactly `bun@<x.y.z>`. A range or a missing field
 *      leaves nothing to compare against.
 *   2. Every tracked Dockerfile reference to `oven/bun` (`FROM oven/bun:<tag>`,
 *      `COPY --from=oven/bun:<tag>`, the `ARG BUN_VERSION=` default a tag
 *      interpolates) names that version. An untagged image (`latest`), a
 *      floating tag (`alpine`, `1.4`) or a variable with no default all fail,
 *      because none of them name a version.
 *   3. Every workflow `oven-sh/setup-bun` step says which bun to install:
 *      `bun-version-file: package.json`, or a literal `bun-version` equal to
 *      the pin (for a step that runs before any checkout). A step with neither
 *      installs whatever bun is newest that day. A literal `BUN_VERSION` env
 *      anywhere in a workflow is held to the pin too.
 *
 * Vacuity floor: a scan that finds no `oven/bun` reference at all FAILS, so a
 * Dockerfile rewrite (or a broken file listing) cannot quietly leave the image
 * unchecked. Comments are ignored: a commented-out `FROM` is not a stage.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+$/;

/** `oven/bun` (optionally `docker.io/`-prefixed) with its tag, if any. */
const BUN_IMAGE =
  /(?:^|[\s=])(?:docker\.io\/)?oven\/bun(?::([^\s@]+))?(?:@sha256:[a-f0-9]+)?(?=\s|$)/i;

export function isDockerfile(path) {
  const name = basename(path);
  return /^Dockerfile(\.(?!dockerignore$)[\w.-]+)?$/.test(name) || /\.Dockerfile$/.test(name);
}

/** Logical Dockerfile instructions: comments dropped, `\` continuations joined. */
export function dockerInstructions(contents) {
  const instructions = [];
  let pending = '';
  for (const raw of contents.split('\n')) {
    const line = raw.trim();
    // Docker drops comment and blank lines even inside a continuation.
    if (line.startsWith('#') || line === '') continue;
    if (line.endsWith('\\')) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    instructions.push(pending + line);
    pending = '';
  }
  if (pending) instructions.push(pending);
  return instructions;
}

/**
 * Every `oven/bun` reference in a Dockerfile, as the bun version it resolves
 * to (or the raw tag when it does not resolve to one).
 */
export function dockerBunReferences(contents) {
  const args = new Map();
  const references = [];
  for (const instruction of dockerInstructions(contents)) {
    const arg = /^ARG\s+(\w+)(?:=(\S+))?/i.exec(instruction);
    if (arg) {
      args.set(arg[1], arg[2]?.replace(/^["']|["']$/g, ''));
      if (arg[1] === 'BUN_VERSION') {
        references.push({ instruction, version: args.get('BUN_VERSION') ?? '(no default)' });
      }
      continue;
    }
    if (!/^(FROM|COPY|RUN\s+--mount)\b/i.test(instruction)) continue;
    const image = BUN_IMAGE.exec(instruction);
    if (!image) continue;
    const tag = (image[1] ?? 'latest').replace(
      /\$\{?(\w+)\}?/g,
      (whole, name) => args.get(name) ?? whole,
    );
    references.push({ instruction, version: tag.split('-')[0], tag });
  }
  return references;
}

/** Every bun a workflow names, and every setup-bun step that names none. */
export function workflowBunPins(contents) {
  const workflow = Bun.YAML.parse(contents) ?? {};
  const pins = [];
  const unpinned = [];
  const envPins = (env, where) => {
    if (env && env.BUN_VERSION !== undefined && !/\$\{\{/.test(String(env.BUN_VERSION))) {
      pins.push({ where: `${where} env BUN_VERSION`, version: String(env.BUN_VERSION) });
    }
  };
  envPins(workflow.env, 'workflow');
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    envPins(job?.env, `job ${jobName}`);
    for (const [index, step] of (job?.steps ?? []).entries()) {
      const where = `job ${jobName} step ${step?.name ?? index + 1}`;
      envPins(step?.env, where);
      if (!String(step?.uses ?? '').startsWith('oven-sh/setup-bun')) continue;
      const withs = step.with ?? {};
      if (withs['bun-version-file'] !== undefined) {
        if (withs['bun-version-file'] !== 'package.json') {
          pins.push({
            where: `${where} bun-version-file`,
            version: `file ${withs['bun-version-file']}`,
          });
        }
      } else if (withs['bun-version'] !== undefined) {
        const version = String(withs['bun-version']);
        // `${{ env.BUN_VERSION }}` resolves to an env literal checked above.
        if (!/\$\{\{/.test(version)) pins.push({ where: `${where} bun-version`, version });
      } else {
        unpinned.push(where);
      }
    }
  }
  return { pins, unpinned };
}

export function checkBunPin({ root } = {}) {
  const repositoryRoot = root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const failures = [];

  const packageManager = String(
    JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')).packageManager ?? '',
  );
  const pinned = /^bun@(\d+\.\d+\.\d+)$/.exec(packageManager)?.[1];
  if (!pinned) {
    throw new Error(
      `root package.json must pin \`packageManager\` as bun@<x.y.z> (found ${JSON.stringify(packageManager)}); ` +
        'without it there is no version to hold the images and workflows to.',
    );
  }

  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

  let imageReferences = 0;
  for (const path of tracked.filter(isDockerfile)) {
    for (const { instruction, version, tag } of dockerBunReferences(
      readFileSync(resolve(repositoryRoot, path), 'utf8'),
    )) {
      imageReferences += 1;
      if (version !== pinned || !SEMVER.test(version)) {
        failures.push(
          `${path}: \`${instruction}\` runs bun ${tag ?? version}, but package.json pins bun@${pinned}. ` +
            'The image must run the bun that wrote bun.lock and that CI tests with.',
        );
      }
    }
  }
  if (imageReferences === 0) {
    throw new Error(
      'found NO `oven/bun` reference in any tracked Dockerfile; the image pin check would measure nothing. ' +
        'If the image stopped using bun, remove this gate in the same change.',
    );
  }

  for (const path of tracked.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))) {
    const { pins, unpinned } = workflowBunPins(readFileSync(resolve(repositoryRoot, path), 'utf8'));
    for (const where of unpinned) {
      failures.push(
        `${path}: ${where} runs oven-sh/setup-bun without a version, so it installs whatever bun is newest. ` +
          'Add `bun-version-file: package.json`.',
      );
    }
    for (const { where, version } of pins) {
      if (version !== pinned) {
        failures.push(`${path}: ${where} is ${version}, but package.json pins bun@${pinned}.`);
      }
    }
  }

  return { pinned, imageReferences, failures };
}

if (import.meta.main) {
  let result;
  try {
    result = checkBunPin();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
  if (result.failures.length > 0) {
    for (const failure of result.failures) console.error(`::error::${failure}`);
    process.exit(1);
  }
  console.log(
    `bun pin is sound: package.json pins bun@${result.pinned}, and all ${result.imageReferences} ` +
      'oven/bun image reference(s) and every workflow setup-bun step use it.',
  );
}
