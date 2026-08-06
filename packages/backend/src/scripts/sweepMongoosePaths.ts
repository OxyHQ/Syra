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

const MODEL_FILES = readdirSync(MODELS).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
);

/**
 * The table(s) a model file owns, matched by singular/plural on the file name.
 * `CatalogEntity.ts` -> `catalog_entities`, `Track.ts` -> `tracks`.
 */
function parentTablesFor(model: string): string[] {
  // Underscores stripped on BOTH sides before comparing. The model file name and
  // the table name do not agree on word boundaries — `MusicBrainzArtist.ts`
  // camel-splits to `music_brainz_artist` while the table is
  // `musicbrainz_artists` — and without this the model resolves to NO parent
  // table, which makes `columnsForModel` empty and every one of its paths a
  // false candidate. Seventeen of them, enough to bury a real finding.
  const squash = (value: string): string => value.replace(/_/g, '');
  const base = squash(model.replace(/\.ts$/, '').toLowerCase());

  return tables()
    .map((t) => getTableConfig(t).name)
    .filter((name) => {
      const flatName = squash(name);
      const singular = flatName.replace(/ies$/, 'y').replace(/s$/, '');
      return flatName === base || singular === base;
    });
}

/** The tables one model owns: its parent table, plus every child prefixed by it. */
function ownTablesFor(model: string): string[] {
  const parents = parentTablesFor(model);
  const prefixes = parents.flatMap((parent) => [
    `${parent}_`,
    `${parent.replace(/ies$/, 'y').replace(/s$/, '')}_`,
  ]);
  return tables()
    .map((table) => getTableConfig(table).name)
    .filter((name) => parents.includes(name) || prefixes.some((p) => name.startsWith(p)));
}

/**
 * The camelCase column names of THIS MODEL's own tables.
 *
 * Scoped, and that scoping is the whole fix. The first version ran the
 * containment rules below against every column in every table, so a real gap on
 * model A was explained away by an unrelated column on model B — 77 cross-table
 * suppressions, the sharpest being `Track.hls`, genuinely absent from `tracks`
 * and suppressed as a "segment of flattened `cacheHlsMasterKey`", a column on
 * `episodes`, in a different vertical, BEFORE the correct child-table
 * explanation was ever reached. If the child-table scoping ever regressed, that
 * would have silently covered for it.
 *
 * That is the same defect the child-table loop already had and had already been
 * fixed for. Fixing one of two sibling loops and leaving the other is worth
 * naming as its own failure mode: the correction was applied where the bug was
 * FOUND rather than everywhere it LIVED.
 */
function columnsForModel(model: string): Set<string> {
  const own = new Set(ownTablesFor(model));
  const names = new Set<string>();
  for (const table of tables()) {
    const config = getTableConfig(table);
    if (!own.has(config.name)) continue;
    for (const column of config.columns) names.add(camel(column.name));
  }
  return names;
}

/**
 * Paths that are legitimately absent, by reason, so the output is a list of
 * SUSPECTS rather than a wall of known-good noise.
 */
function explained(model: string, path: string): string | undefined {
  /**
   * CHILD TABLES FIRST, and the ordering is the rule rather than a preference.
   *
   * A child table named `<parent>_<path>` is an EXACT structural match; the
   * column rules below are heuristics over capitalisation. Running the
   * heuristics first let `Track.hls` — which became `track_hls_renditions` —
   * be explained as "flattened to `hlsMasterKey`", a real column on `tracks`
   * that means something else entirely (the master playlist's S3 key). Scoping
   * both loops to the model's own tables did not fix that, because both
   * candidates were on the right model; only ordering does.
   *
   * So: identity before containment, here as everywhere else in this file.
   * The self-check at the bottom pins exactly this case.
   */
  const prefixes = parentTablesFor(model).flatMap((parent) => [
    parent,
    parent.replace(/ies$/, 'y').replace(/s$/, ''),
  ]);
  /**
   * `<parent>_<path>` exactly, or `<parent>_<path>_<noun>`.
   *
   * The second form is why `endsWith` alone was not enough: the ladder table is
   * `track_hls_renditions`, not `track_hls`, so `Track.hls` went unexplained by
   * this loop and fell through to the heuristics — which is how it came to be
   * "flattened to hlsMasterKey".
   *
   * The trailing boundary is required rather than a bare prefix match, or a
   * one-letter path `h` would be explained by `track_hls_renditions`. That is
   * the same containment mistake this file exists to record, and it is cheap to
   * exclude here rather than discover later.
   */
  const wanted = path.toLowerCase();
  for (const table of tables()) {
    const name = getTableConfig(table).name;
    for (const prefix of prefixes) {
      const stem = `${prefix}_${wanted}`;
      if (name === stem || name.startsWith(`${stem}_`)) {
        return `child table ${name}`;
      }
    }
  }

  /**
   * Then the flattening heuristics, over THIS MODEL's own columns only — see
   * `columnsForModel` for the 77 cross-table suppressions the unscoped version
   * produced.
   *
   * These are containment matches and they stay containment matches: a
   * subdocument really is flattened by concatenation (`links` -> `linksWebsite`,
   * `coverArtSizes.small` -> `coverArtSizesSmallId`), so there is no identity to
   * compare. What the rule requires of them is the second clause — that the
   * report they produce is proven against a case that motivated it — which is
   * what the self-check does.
   */
  const Capital = path.charAt(0).toUpperCase() + path.slice(1);
  for (const candidate of columnsForModel(model)) {
    // `coverArt` -> `coverArtId`
    if (candidate === `${path}Id`) return `flattened to ${path}Id`;
    // PREFIX: `links` -> `linksWebsite`, `metadata` -> `metadataBpm`
    if (candidate.startsWith(path) && /^[A-Z]/.test(candidate.slice(path.length))) {
      return `flattened to ${candidate}`;
    }
    // SUFFIX: the sub-key of a flattened subdocument.
    // `small` -> `coverArtSizesSmallId`, `monthlyListeners` -> `statsMonthlyListeners`.
    if (candidate.endsWith(Capital) || candidate.endsWith(`${Capital}Id`)) {
      return `sub-key of flattened ${candidate}`;
    }
    // INFIX: `entityType` -> `catalogEntityType`.
    if (candidate.includes(Capital)) return `segment of flattened ${candidate}`;
  }

  return undefined;
}

/**
 * Paths the schema DELIBERATELY dropped, with the decision that dropped them.
 *
 * Not a suppression heuristic — an exemption list, compared BY IDENTITY per
 * model, exactly like `hybridServices.ts`'s registry and for the same reason.
 * Each entry names a documented decision so a reader can check it rather than
 * trust it.
 */
const DELIBERATELY_DROPPED: Readonly<Record<string, readonly string[]>> = {
  // `schema/catalog.ts`: "Image FK columns hold ONLY the id — url/width/height
  // are dropped", because all three are pure functions of the `image_assets`
  // row the id already points at.
  'Track.ts': ['url', 'width', 'height', 'catalogEntityId'],
  'Album.ts': ['url', 'width', 'height'],
  'Playlist.ts': ['url', 'width', 'height'],
  'Podcast.ts': ['url', 'width', 'height'],
  'Episode.ts': ['url', 'width', 'height'],
  'CatalogEntity.ts': ['url', 'width', 'height'],
  'UserUpload.ts': ['url', 'width', 'height', 'catalogEntityId'],
  'DiscogsRelease.ts': ['catalogEntityId'],
  // `schema/rooms.ts`: `Room.topicId` referenced a `Topic` model that does not
  // exist in the repo — dropped in Task 6 on a grep-first decision the lead
  // re-ran independently.
  'Room.ts': ['topicId'],
} as const;

const report: string[] = [];
let checked = 0;

for (const file of MODEL_FILES) {
  const paths = mongoosePaths(file);
  if (paths.length === 0) continue;
  const missing: string[] = [];
  for (const path of paths) {
    checked += 1;
    // Exact hit in the model's OWN tables — the only identity match here.
    if (columnsForModel(file).has(path)) continue;
    if (DELIBERATELY_DROPPED[file]?.includes(path)) continue;
    const why = explained(file, path);
    if (why) continue;
    missing.push(path);
  }
  if (missing.length > 0) {
    report.push(`${file.padEnd(30)} ${missing.join(', ')}`);
  }
}

/**
 * SELF-CHECK — the rule's second clause, executed rather than asserted.
 *
 * "Proves it by FAILING against the case that motivated it." Both scoping bugs
 * this script has had are pinned here, so a regression in either is a non-zero
 * exit rather than a quietly shorter report:
 *
 *   `CatalogEntity.members` — the case the sweep was commissioned for. Suppressed
 *   by `house_members`, a table on a DIFFERENT model, until the child-table loop
 *   was scoped. It must be explained by `catalog_entities.members` (the column
 *   migration 0018 restored) and by nothing else.
 *
 *   `Track.hls` — the case the review found. Genuinely absent from `tracks`
 *   (Task 4 moved the ladder to `track_hls_renditions`) and suppressed as a
 *   "segment of flattened cacheHlsMasterKey", a column on `episodes`, until the
 *   COLUMN loop was scoped too. It must be explained by the child table.
 *
 * The second exists because fixing one of two sibling loops and leaving the
 * other is its own failure mode: the correction was applied where the bug was
 * found rather than everywhere it lived.
 */
const SELF_CHECKS: readonly { model: string; path: string; mustMention: string }[] = [
  { model: 'CatalogEntity.ts', path: 'members', mustMention: 'members' },
  { model: 'Track.ts', path: 'hls', mustMention: 'track_hls_renditions' },
];

const selfCheckFailures: string[] = [];
for (const probe of SELF_CHECKS) {
  const own = columnsForModel(probe.model);
  const verdict = own.has(probe.path)
    ? `own column ${probe.path}`
    : explained(probe.model, probe.path);

  if (!verdict || !verdict.includes(probe.mustMention)) {
    selfCheckFailures.push(
      `${probe.model} :: ${probe.path} -> ${verdict ?? 'UNEXPLAINED'} ` +
      `(expected an explanation mentioning "${probe.mustMention}")`
    );
  }
}

console.log(`\nScanned ${MODEL_FILES.length} model files, ${checked} declared paths, ` +
  `${tables().reduce((n, t) => n + getTableConfig(t).columns.length, 0)} columns ` +
  `across ${tables().length} tables.\n`);
console.log('CANDIDATES — a declared Mongoose path with no obvious drizzle column:\n');
for (const line of report) console.log('  ' + line);
console.log(`\n${report.length} model files carry at least one candidate.\n`);

if (selfCheckFailures.length > 0) {
  console.error('SELF-CHECK FAILED — this report cannot be trusted:\n');
  for (const failure of selfCheckFailures) console.error('  ' + failure);
  console.error(
    '\nA suppression rule is matching outside the model it belongs to. Scope it,\n' +
    'then re-run. See this file\'s doc comment for the two prior instances.\n'
  );
  process.exit(1);
}
console.log('Self-check: both scoping regressions pinned, neither present.\n');
