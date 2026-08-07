/**
 * Every connectivity gate asks about a database its handlers actually use.
 *
 * A gate is `if (!isXConnected()) return 503`. Getting the database wrong is
 * silent in both directions: the wrong one down answers 503 for work that would
 * have succeeded, and the right one down sails past the guard and throws inside
 * the handler. Neither `tsc` nor any suite that opens both databases can see it
 * — which is exactly how six of these survived the first six verticals.
 *
 * It gets worse at Task 19. `isDatabaseConnected()` is
 * `mongoose.connection.readyState`, so once Mongo is removed it never reaches 1
 * again and every route behind such a gate 503s **permanently**, with no error
 * and no log. That is the quietest way this migration can break something.
 *
 * ## Why this walks the IMPORT GRAPH rather than grepping each file
 *
 * Because a grep of the gated file is not the question. `entityProfile.controller`
 * carried a Mongo gate whose justification was two hops away — through
 * `services/catalog/artistProfile.ts` — and a grep of the controller found
 * nothing. The question is whether ANYTHING the entry point can reach opens a
 * Mongoose model, and only a transitive walk answers it.
 *
 * ## This file is the committed form of a throwaway script, and that is the point
 *
 * Task 15's sweep was verified with an ad-hoc walker that was never committed.
 * The result was correct and **nobody else could check it**: an uncommitted
 * verification tool is an unverifiable claim, and a walker that always answered
 * "no Mongoose" would have produced the same clean sweep. So it lives here, with
 * its control, and it now guards against regression instead of asserting a
 * one-time fact.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

// `__dirname`, not `import.meta.dir`: this package builds to CommonJS — the same
// reason `db/catalog/__tests__/hybridServices.test.ts` gives.
const SRC = join(__dirname, '..', '..');

/**
 * Import specifiers, with comments removed first.
 *
 * Stripping matters and is not hygiene: several files in this sweep DISCUSS
 * `models/…` paths in prose (`db/postgres.ts`, `radio.controller.ts`, and the
 * four suites whose comments this change corrects). A matcher that read comments
 * would report a Mongoose dependency for a file whose only mention of one is an
 * explanation that it no longer has any — a false positive on precisely the
 * files most likely to be checked.
 */
function importsIn(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  return [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
}

function resolveRelative(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** A `models/<Name>` import is the thing this walk is looking for. */
const MODEL_IMPORT = /(^|\/)models\/[A-Za-z0-9_]+$/;

interface Reach {
  /** Files visited, as a floor against a traversal that stopped early. */
  readonly visited: number;
  /** Every Mongoose model reachable, with the path that reaches it. */
  readonly models: readonly { readonly model: string; readonly via: string }[];
}

function reach(entry: string): Reach {
  const start = resolve(SRC, entry);
  if (!existsSync(start)) throw new Error(`no such entry point: ${entry}`);

  const seen = new Set<string>();
  const models: { model: string; via: string }[] = [];
  const stack: { file: string; path: string[] }[] = [{ file: start, path: [start] }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current.file)) continue;
    seen.add(current.file);

    let text: string;
    try {
      text = readFileSync(current.file, 'utf8');
    } catch {
      continue;
    }

    for (const spec of importsIn(text)) {
      if (MODEL_IMPORT.test(spec)) {
        models.push({
          model: spec,
          via: current.path.map((file) => relative(SRC, file)).join(' -> '),
        });
        continue;
      }
      const next = resolveRelative(current.file, spec);
      if (next && !seen.has(next)) stack.push({ file: next, path: [...current.path, next] });
    }
  }

  return { visited: seen.size, models };
}

/**
 * Every entry point that carries a connectivity gate, or is reached only through
 * one. Each must gate on Postgres, which is only correct while none of them can
 * reach a Mongoose model.
 */
const POSTGRES_ONLY_ENTRY_POINTS: readonly string[] = [
  'controllers/recommendations.controller.ts',
  'controllers/radio.controller.ts',
  'controllers/entityProfile.controller.ts',
  // `utils/withDb.ts` holds the gate; this is the router whose handlers it wraps.
  'routes/playlists.routes.ts',
  'services/recommendations/coOccurrenceJob.ts',
  'services/recommendations/tasteDecay.ts',
];

/**
 * A file that genuinely still reaches Mongoose, including through a hop.
 *
 * THE ASSERTION THAT MAKES THE REST MEAN ANYTHING. Every check below is an
 * absence, so a walker that resolved nothing — a broken `resolveRelative`, a
 * regex that stopped matching, a `readFileSync` that threw — would report a
 * perfectly clean sweep. This one has to come back dirty.
 *
 * Task 8's moderation vertical is blocked, so this file is expected to keep its
 * models for some time. When Task 8 lands and this control goes green, the whole
 * file has done its job: delete it rather than weakening the control.
 */
const MONGOOSE_CONTROL = 'moderation/enforcement-service.ts';

describe('the control still finds Mongoose', () => {
  it('reaches a model directly AND through a hop', () => {
    const { models, visited } = reach(MONGOOSE_CONTROL);
    const names = models.map((hit) => hit.model);

    expect(names).toContain('../models/Report');
    expect(names).toContain('../models/ModerationEnforcement');

    // A TRANSITIVE hit, not just direct ones — the property the whole walk
    // exists for, and the one a grep of the entry file cannot have.
    const transitive = models.filter((hit) => hit.via.includes(' -> '));
    expect(`transitive hits: ${transitive.map((h) => h.via).join('; ') || 'NONE'}`).toContain(' -> ');

    expect(visited).toBeGreaterThan(5);
  });

  it('does not count a model named only in a comment', () => {
    // The false positive the comment-stripping prevents, asserted directly
    // rather than trusted — `db/postgres.ts` and four suites discuss these paths
    // in prose.
    expect(importsIn("/* see '../models/Report' */\nimport { x } from './real';")).toEqual([
      './real',
    ]);
    expect(importsIn("// from '../models/Report'\nimport { y } from './other';")).toEqual([
      './other',
    ]);
    // And a real import is still found, so the stripper has not eaten everything.
    expect(importsIn("import { z } from '../models/Report';")).toEqual(['../models/Report']);
  });
});

describe('every Postgres-gated entry point is free of Mongoose', () => {
  for (const entry of POSTGRES_ONLY_ENTRY_POINTS) {
    it(`${entry} reaches no Mongoose model`, () => {
      const { models, visited } = reach(entry);

      // Named, so a failure says WHICH model and through which hop rather than
      // leaving the next person to re-derive the path.
      expect(`${entry}: ${models.map((hit) => `${hit.model} via ${hit.via}`).join('; ') || 'clean'}`)
        .toContain('clean');

      // Vacuity floor: a walk that resolved almost nothing would also be clean.
      expect(visited).toBeGreaterThan(10);
    });
  }

  it('gates every entry point the sweep covered', () => {
    // A list silently truncated to nothing would pass the loop above by
    // checking nothing at all.
    expect(POSTGRES_ONLY_ENTRY_POINTS.length).toBe(6);
  });
});
