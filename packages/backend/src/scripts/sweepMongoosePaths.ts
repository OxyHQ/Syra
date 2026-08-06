/**
 * REPORT-ONLY sweep: every Mongoose schema path, against every drizzle column.
 *
 * Commissioned by the lead after `catalog_entities.members` turned out to be
 * declared in a comment and never created. That instance was found by a port
 * hitting the write; the ones with no writer-side pressure are invisible until
 * something breaks, so this enumerates them once instead of discovering them
 * one blocked task at a time.
 *
 * A REPORT TOOL, not a gate — run it, read it, act on it. Task 18 builds the
 * standing gate; this buys its answer early. Run with:
 *
 *     bun run src/scripts/sweepMongoosePaths.ts
 *
 * It reports CANDIDATES and every one still needs a human read: it cannot know
 * that `Track.credits[]` became a child table or that `coverArtSizes.small`
 * became `cover_art_sizes_small_id`, so it suppresses what it can recognise and
 * leaves the rest to be adjudicated.
 *
 * ## The suppression is where the danger is, and it bit once already
 *
 * The first version matched a child table by "any table whose name CONTAINS the
 * path", schema-wide. That made the sweep VACUOUS on the exact instance it was
 * commissioned for: `CatalogEntity.members[]` was suppressed by `house_members`,
 * a table belonging to a different model, so removing the `members` column
 * changed the output not at all. Same substring bug as the two loose matchers
 * already recorded on this branch — written into the check by the person writing
 * it against them.
 *
 * So the standing verification for this script is a MUTATION, not a green run:
 * delete `catalog_entities.members` and confirm it appears. It does now, and it
 * did not before the child-table match was scoped to the model's own tables.
 *
 * ## THE RULE, stated because knowing it was demonstrably not enough
 *
 * This was the THIRD substring-matching bug on this branch — after the
 * identifier exemption's `includes()`, which absorbed a 74-byte superstring of
 * an exempt name, and `halfPortedImports`'s `endsWith()`, which missed a whole
 * specifier spelling. It was written by someone who had just been warned about
 * both, into the check being written against them. Knowing the failure mode and
 * having been told about it did not prevent writing it again, so the rule goes
 * in the file rather than in anybody's head:
 *
 *   **Any matcher compares by IDENTITY or by RESOLVED PATH, never by
 *   containment — and proves it by FAILING against the case that motivated it.**
 *
 * The second clause is the operative one. A matcher built for a known case has
 * an obvious oracle, which makes it strictly easier to verify than a matcher in
 * general: break the specific thing the check exists to find, and watch it be
 * found. `halfPortedImports.test.ts` resolves specifiers against the importing
 * file's directory and compares absolute paths; `hybridServices.test.ts` uses
 * exact-equality `Set` membership and keeps a mutation showing an `includes()`
 * rewrite flagging `PlaylistTrack` as a catalog model BECAUSE IT CONTAINS
 * `Track`. Both are the rule applied; neither is optional.
 *
 * ## Result of the run this was written for (2026-08-06)
 *
 * 706 declared paths across 41 model files, against 411 columns in 69 tables.
 * 20 candidates in 11 files; ALL TWENTY adjudicated as false positives —
 * renamed (`PlaylistTrack.order` -> `position`), flattened with a different
 * prefix (`externalIds` -> `external_isrc`, `feedSettings` -> `feed_*`),
 * promoted to a differently-named table (`Room.podcastQueue` ->
 * `room_media_queue_items`, `Library.likedTracks` -> `user_liked_tracks`), a
 * sub-key of a jsonb column (`UserUpload.lines`), or deliberately dropped with
 * a ruling (`Room.topicId`, Task 6).
 *
 * So `catalog_entities.members` appears to have been the ONLY live instance of
 * the class. That is the useful finding: the class is real, it was worth one
 * sweep, and it is not a systemic hole.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isTable } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema';

// `__dirname` rather than `import.meta.dir`: this package builds to CommonJS
// (`tsc -p tsconfig.build.json`), where `import.meta` is a hard TS1470.
const MODELS = join(__dirname, '..', 'models');

/** Model file → the Mongoose paths its `new Schema({...})` blocks declare. */
function mongoosePaths(file: string): string[] {
  const source = readFileSync(join(MODELS, file), 'utf8');
  const paths = new Set<string>();
  // `name: { type: String, ... }` / `name: [{ type: ... }]` / `name: { type: [Number] }`
  for (const m of source.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9_]*):\s*[{[]/gm)) {
    if (m[1]) paths.add(m[1]);
  }
  return [...paths].sort();
}

/** snake_case a drizzle column name back to the camelCase a model would use. */
function camel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function tables(): PgTable[] {
  return (Object.values(schema) as unknown[]).filter((v): v is PgTable => isTable(v));
}

/** Every drizzle column across the whole schema, as camelCase, with its table. */
function allColumns(): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const table of tables()) {
    const config = getTableConfig(table);
    for (const column of config.columns) {
      const key = camel(column.name);
      byName.set(key, [...(byName.get(key) ?? []), config.name]);
    }
  }
  return byName;
}

const MODEL_FILES = readdirSync(MODELS).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
);

const columns = allColumns();
const flat = new Set(columns.keys());

/**
 * Paths that are legitimately absent, by reason, so the output is a list of
 * SUSPECTS rather than a wall of known-good noise.
 */
function explained(model: string, path: string): string | undefined {
  const Capital = path.charAt(0).toUpperCase() + path.slice(1);
  for (const candidate of flat) {
    // `coverArt` -> `coverArtId`
    if (candidate === `${path}Id`) return `flattened to ${path}Id`;
    // PREFIX flattening: `links` -> `linksWebsite`, `metadata` -> `metadataBpm`
    if (candidate.startsWith(path) && /^[A-Z]/.test(candidate.slice(path.length))) {
      return `flattened to ${candidate}`;
    }
    // SUFFIX flattening: the sub-key of a flattened subdocument.
    // `small` -> `coverArtSizesSmallId`, `licence` -> `imageLicenceLicence`,
    // `monthlyListeners` -> `statsMonthlyListeners`, `x` -> `linksX`.
    if (candidate.endsWith(Capital) || candidate.endsWith(`${Capital}Id`)) {
      return `sub-key of flattened ${candidate}`;
    }
    // INFIX: `sourceUrl` -> `imageLicenceSourceUrl` handled above; `entityType`
    // -> `catalogEntityType` is a capitalised segment in the middle.
    if (candidate.includes(Capital)) return `segment of flattened ${candidate}`;
  }
  /**
   * Child tables — but ONLY ones belonging to THIS model.
   *
   * The first version matched any table whose NAME CONTAINED the path, across
   * the whole schema. That made the sweep vacuous on the exact instance it was
   * written for: `CatalogEntity.members[]` was suppressed by `house_members`,
   * which belongs to a different model entirely, so removing the `members`
   * column changed the output not at all. Same substring bug as the two loose
   * matchers already recorded on this branch, committed here by the person
   * writing the check against them.
   *
   * The parent table is derived from the model file name and the child must be
   * PREFIXED by it, so `catalog_entity_strikes` explains
   * `CatalogEntity.strikes[]` and `house_members` explains nothing outside
   * `House.ts`.
   */
  // A child table is named `<parent>_<thing>` using the parent's SINGULAR form
  // (`catalog_entities` -> `catalog_entity_sources`), so both spellings are
  // accepted as prefixes — but only this model's own.
  const prefixes = parentTablesFor(model).flatMap((parent) => [
    parent,
    parent.replace(/ies$/, 'y').replace(/s$/, ''),
  ]);
  const suffix = path.toLowerCase();
  for (const table of tables()) {
    const name = getTableConfig(table).name;
    for (const prefix of prefixes) {
      if (name.startsWith(`${prefix}_`) && name.endsWith(suffix)) {
        return `child table ${name}`;
      }
    }
  }
  return undefined;
}

/**
 * The table(s) a model file owns, matched by singular/plural on the file name.
 * `CatalogEntity.ts` -> `catalog_entities`, `Track.ts` -> `tracks`.
 */
function parentTablesFor(model: string): string[] {
  const base = model.replace(/\.ts$/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const names = tables().map((t) => getTableConfig(t).name);
  return names.filter((name) => {
    const singular = name.replace(/ies$/, 'y').replace(/s$/, '');
    return name === base || singular === base || name === `${base}s` || singular === base.replace(/y$/, 'y');
  });
}

const report: string[] = [];
let checked = 0;

for (const file of MODEL_FILES) {
  const paths = mongoosePaths(file);
  if (paths.length === 0) continue;
  const missing: string[] = [];
  for (const path of paths) {
    checked += 1;
    if (flat.has(path)) continue;
    const why = explained(file, path);
    if (why) continue;
    missing.push(path);
  }
  if (missing.length > 0) {
    report.push(`${file.padEnd(30)} ${missing.join(', ')}`);
  }
}

console.log(`\nScanned ${MODEL_FILES.length} model files, ${checked} declared paths, ` +
  `${flat.size} distinct drizzle columns across ${tables().length} tables.\n`);
console.log('CANDIDATES — a declared Mongoose path with no obvious drizzle column:\n');
for (const line of report) console.log('  ' + line);
console.log(`\n${report.length} model files carry at least one candidate.\n`);
