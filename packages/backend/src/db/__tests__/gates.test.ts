/**
 * The four schema-convention gates every Oxy Postgres backend is held to,
 * imported from `@oxyhq/db/assert` and driven against THIS schema's own data:
 *
 *   - `findIdColumnViolations` — every `*_id`-shaped column is classified,
 *     via `schema/deferredForeignKeys.ts`'s two ledgers plus the real
 *     `.references()` constraints. Pure: reads the drizzle schema objects,
 *     no database needed.
 *   - `findImplicitWholeRowReads` — no bare `.select()` or `db.query.<table>`
 *     read of a table `schema/protectedColumns.ts` protects. Scans source,
 *     no database needed.
 *   - `findSchemaInvariantViolations` — schema-wide conventions (naming,
 *     casing, ...), checked against the MIGRATED database's own catalogue.
 *   - `findUnsupportedExpiryColumns` — every `db/expiry.ts` sweep target has
 *     a supporting index, checked against the same catalogue.
 *
 * The last two need a real, migrated Postgres — `beforeAll` connects to
 * `TEST_DATABASE_URL` (or `DATABASE_URL` as a local-dev fallback), the same
 * database `bun run db:migrate` was run against.
 *
 * `MINIMUM_TABLES` is a vacuity floor, not a target: fewer tables than this
 * means the traversal itself is broken (a wrong `sourceDir`, an empty
 * `schema` barrel import) rather than a clean schema. It was `0` when the
 * schema was empty; Task 2 (the catalog vertical) raised it to 19 — the
 * nineteen tables `schema/catalog.ts` and `schema/genres.ts` export — and
 * every later schema task raises it again. A floor that never moves is a
 * vacuity check that stopped checking.
 *
 * THIS FLOOR IS A VACUITY CHECK, AND VACUITY CHECKS HAVE A BLIND SPOT WORTH
 * NAMING: Task 1's `tables()` helper below (`is(value, PgTable)` against
 * `Object.values(schema)`) and its `.rejects` usage in the CHECK-constraint
 * test pattern both carried real defects (see the two fixes in this file's
 * history) that a thorough review of Task 1 did not catch, for the same
 * reason `minimumTables: 0` did not catch anything either: the schema was
 * EMPTY, so `Object.values(schema)` was never heterogeneous and nothing was
 * ever inserted — the exact inputs that expose both bugs. A gate that has
 * never been exercised against real data is unproven, not passing; it only
 * broke the moment Task 2 gave it its first real input. That is why the
 * floor is raised, and mutation-checked, at every schema task rather than
 * trusted once and left alone.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, getTableColumns, inArray, isTable, sql } from 'drizzle-orm';
import { getTableConfig, PgTable, type UpdateDeleteAction } from 'drizzle-orm/pg-core';
import {
  constraintNameOf,
  executeRows,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  sqlColumnName,
} from '@oxyhq/db';
import {
  findIdColumnViolations,
  findImplicitWholeRowReads,
  findSchemaInvariantViolations,
  findUnsupportedExpiryColumns,
} from '@oxyhq/db/assert';
import { readJournal, readMigrationPhases, type DeployPhase } from '@oxyhq/db/migrate';
import { closePostgres, getDb } from '../postgres';
import { connectUnmanagedDb } from '../../test/postgres';
import { findMigrationsFolder, LAST_GENESIS_MIGRATION_TAG } from '../migrate';
import * as schema from '../schema';
import * as catalogModule from '../schema/catalog';
import { albumGenres, albums, catalogEntities, imageAssets, trackHlsRenditions, tracks } from '../schema/catalog';
import * as genresModule from '../schema/genres';
import * as libraryModule from '../schema/library';
import { playbackStates, playlists, userPodcastSubscriptions, userSavedPlaylists } from '../schema/library';
import * as podcastsModule from '../schema/podcasts';
import { episodeHlsRenditions, episodeProgress, episodes, podcastCategories, podcasts } from '../schema/podcasts';
import * as creatorsModule from '../schema/creators';
import {
  artistClaims,
  contributionAttestationProvenanceMarkers,
  contributionAttestations,
  contributorStandings,
  contributorStrikes,
  copyrightReports,
  userUploadHlsRenditions,
  userUploadProvenanceMarkers,
  userUploads,
} from '../schema/creators';
import * as roomsModule from '../schema/rooms';
import {
  houseMembers,
  houses,
  recordings,
  roomMediaQueueItems,
  roomUserPreferences,
  rooms,
  series,
  seriesEpisodes,
} from '../schema/rooms';
import * as userModule from '../schema/user';
import {
  catalogRelations,
  listeningEvents,
  notificationPreferences,
  notificationSuppressions,
  userBehavior,
  userMusicPreferences,
  userSettings,
  userTasteArtists,
  userTasteGenres,
  userTasteProfiles,
} from '../schema/user';
import * as trackKeysModule from '../schema/trackKeys';
import { trackKeys } from '../schema/trackKeys';
import { DEFERRED_FOREIGN_KEYS, ID_COLUMNS_WITHOUT_FOREIGN_KEY } from '../schema/deferredForeignKeys';
import { PROTECTED_COLUMNS_BY_TABLE } from '../schema/protectedColumns';
import { EXPIRY_SWEEP_TARGETS } from '../expiry';
import { genres } from '../schema/genres';

/**
 * Traversal floor for every gate below. See this file's own doc comment.
 * 19 (Task 2: catalog.ts + genres.ts) + 12 (Task 3: library.ts) +
 * 10 (Task 4: podcasts.ts) + 1 (Task 4 follow-up: catalog.ts's
 * `track_hls_renditions`, correcting `tracks.hls`'s jsonb-vs-child-table
 * inconsistency with `episode_hls_renditions` — see catalog.ts's own
 * comment) + 9 (Task 5: creators.ts) + 8 (Task 6: rooms.ts) +
 * 10 (Task 7: user.ts) + 4 (Task 8: moderation.ts — `reports` plus the three
 * `@oxyhq/crowdsource-app` owns) = 73.
 */
const MINIMUM_TABLES = 73;

/**
 * Every drizzle table the schema barrel exports, walked rather than listed by
 * hand.
 *
 * `Object.values(schema)` is cast to `unknown[]` FIRST, and that is load-
 * bearing, not decoration. The barrel also exports plain `as const` value-set
 * tuples (`CATALOG_SOURCES` and friends) — once the union of everything
 * `schema` exports is large and heterogeneous enough, TypeScript's own
 * literal type for `Object.values(schema)` includes branded types like
 * `PgTableWithColumns<{ name: "discogs_releases"; … }>`, and a predicate of
 * `value is PgTable` against THAT union fails `TS2677` ("a type predicate's
 * type must be assignable to its parameter's type") — `PgTable<TableConfig>`
 * is a strict supertype of the specific branded table type, not a match in
 * the direction the check wants, for every union member simultaneously.
 * Widening the callback's own parameter type to `unknown` sidesteps the
 * union entirely: any predicate is trivially assignable to `unknown`. The
 * runtime check (`isTable`, `drizzle-orm/table.js`'s `IsDrizzleTable` brand)
 * is unaffected either way.
 */
function tables(): PgTable[] {
  return (Object.values(schema) as unknown[]).filter((value): value is PgTable => isTable(value));
}

/**
 * The same walk as {@link tables}, scoped to one or more schema MODULES
 * rather than the whole barrel — what a per-task "lands exactly the tables
 * this task promises" test needs. Using the barrel-wide {@link tables} for
 * that assertion would break the moment any LATER task's module lands a new
 * table, since the barrel is cumulative and a per-task list is not; scoping
 * to the owning module(s) keeps each task's own test self-contained forever,
 * with nothing for a later task to come back and edit.
 */
function tablesIn(...modules: readonly Record<string, unknown>[]): PgTable[] {
  return modules.flatMap((module) =>
    (Object.values(module) as unknown[]).filter((value): value is PgTable => isTable(value))
  );
}

/**
 * The C1 fix (Task 4 review): every migration AFTER `boundaryTag` is a REAL
 * rollout with a live predecessor to protect, so `planMigrationRun`'s
 * ordering invariant — no `pre` migration ordered behind a `post` one — must
 * actually hold for that window, unlike the genesis window before it (see
 * `migrate.ts`'s own "THE GENESIS BOOTSTRAP WINDOW" doc comment for why that
 * window is exempt). Pure: takes an already-ordered tag/phase list rather
 * than reading the journal itself, so it can be exercised against a
 * synthetic sequence in a unit test as well as the real one.
 *
 * Returns one message per violation — a `pre` tag positioned at or after the
 * first `post` tag strictly after the boundary — empty when the invariant
 * holds. Also reports if `boundaryTag` itself is not in `entries` at all
 * (a stale boundary constant), since every other check here is meaningless
 * against a boundary that does not exist in the journal it is being checked
 * against.
 */
function findPostGenesisPhaseOrderingViolations(
  entries: readonly { tag: string; phase: DeployPhase }[],
  boundaryTag: string
): string[] {
  const boundaryIndex = entries.findIndex((entry) => entry.tag === boundaryTag);
  if (boundaryIndex === -1) {
    return [`boundary tag "${boundaryTag}" is not present in the migration journal at all.`];
  }

  const postGenesis = entries.slice(boundaryIndex + 1);
  const violations: string[] = [];
  let firstPostTag: string | null = null;
  for (const entry of postGenesis) {
    if (entry.phase === 'post' && firstPostTag === null) {
      firstPostTag = entry.tag;
    } else if (entry.phase === 'pre' && firstPostTag !== null) {
      violations.push(`${entry.tag} is "pre" but is ordered behind "${firstPostTag}" ("post").`);
    }
  }
  return violations;
}

/**
 * Postgres truncates any identifier past `NAMEDATALEN - 1` = 63 bytes, with a
 * NOTICE nobody reads and no error. The constraint is created under a
 * DIFFERENT name than the one declared, drizzle's snapshot keeps the declared
 * one, and a future `DROP CONSTRAINT`/`ALTER ... RENAME` by that name fails
 * against a database that has never held it.
 *
 * This is not hypothetical: `0000` (Task 2) declares a 71-byte foreign-key
 * name on `musicbrainz_artist_urls`, and the database holds its 63-byte
 * truncation. Nothing in the repo would have caught it, which is what
 * {@link findOverlongIdentifiers} exists to change.
 */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * Identifiers already over the limit when this gate landed.
 *
 * Same contract as `deferredForeignKeys.ts`'s two ledgers: an entry is a
 * NAMED, reasoned debt rather than a silently-lowered bar, and an entry that
 * stops being over-limit (or stops existing) fails as
 * `stale_identifier_exemption` rather than lingering.
 */
const OVERLONG_IDENTIFIER_EXEMPTIONS: readonly { identifier: string; reason: string }[] = [
  {
    identifier: 'musicbrainz_artist_urls_musicbrainz_artist_id_musicbrainz_artists_id_fk',
    reason:
      "Pre-existing: declared by 0000 (Task 2) at 71 bytes, so `syra_dev` holds it as " +
      '`musicbrainz_artist_urls_musicbrainz_artist_id_musicbrainz_artis`. Verified against ' +
      'pg_constraint — it is the ONLY declared identifier in eleven migrations that does not exist ' +
      'in the database under its declared name. Fixing it needs a hand-written migration (DROP by ' +
      "the truncated name, ADD with an explicit short one) on Task 2's table, so it is tracked here " +
      'rather than fixed inside Task 5.',
  },
];

/**
 * Every over-long identifier in a migration's SQL, by byte length.
 *
 * Reads the SQL FILES rather than the drizzle objects, and that is the load-
 * bearing choice: `ForeignKey#getName()` builds its name from the TypeScript
 * PROPERTY names (`musicbrainz_artist_urls_musicbrainzArtistId_...`, 69
 * bytes), while the DDL drizzle-kit emits uses the SQL column names
 * (`..._musicbrainz_artist_id_...`, 71 bytes). A gate reading `getName()`
 * would measure a string the database never sees, and snake_case is the
 * LONGER of the two — so it would under-count and miss violations. The `.sql`
 * files are what Postgres actually executes.
 *
 * Pure over `(file, text)` pairs so the checker itself can be exercised
 * against a synthetic statement — see the boundary test below, which is what
 * keeps this from being a check that cannot fail.
 *
 * Returns the identifier as its OWN FIELD rather than only a formatted
 * message, and that is the fix for a real defect this gate shipped with: the
 * first version matched exemptions with `violation.includes(name)` against the
 * formatted string, so any identifier CONTAINING an exempt name was absorbed
 * by it. A 74-byte `musicbrainz_artist_urls_..._id_fk_two` passed the gate,
 * and a superstring also kept a paid-off exemption looking live. Structured
 * output is what lets {@link findUnexemptedIdentifiers} compare by identity.
 */
interface OverlongIdentifier {
  readonly identifier: string;
  readonly file: string;
  readonly bytes: number;
}

function findOverlongIdentifiers(
  files: readonly { file: string; text: string }[]
): { violations: OverlongIdentifier[]; scanned: number } {
  const seen = new Map<string, string>();
  for (const { file, text } of files) {
    // Identifiers are double-quoted in generated DDL; string literals are
    // single-quoted, so this cannot pick up a value by mistake.
    for (const match of text.matchAll(/"([^"]+)"/g)) {
      const identifier = match[1];
      if (!seen.has(identifier)) seen.set(identifier, file);
    }
  }

  const violations: OverlongIdentifier[] = [];
  for (const [identifier, file] of seen) {
    const bytes = Buffer.byteLength(identifier, 'utf8');
    if (bytes > MAX_IDENTIFIER_BYTES) violations.push({ identifier, file, bytes });
  }
  return { violations, scanned: seen.size };
}

/**
 * Split over-long identifiers into the ones no exemption covers and the
 * exemptions no violation still justifies.
 *
 * Both halves compare by EXACT identity against a `Set`, never by substring.
 * The substring version of this — `violation.includes(entry.identifier)` —
 * failed in both directions at once: a superstring of an exempt name was
 * silently absorbed (the gate kept passing while it stopped checking, exactly
 * what the vacuity floors exist to prevent), and that same superstring kept a
 * paid-off exemption looking live, so the staleness check could not report it
 * either. Pure, so both directions are proven against synthetic input below
 * rather than against a real schema that happens to hold one known violation
 * forever.
 */
function findUnexemptedIdentifiers(
  violations: readonly OverlongIdentifier[],
  exemptions: readonly { identifier: string; reason: string }[]
): { unexempted: OverlongIdentifier[]; stale: string[] } {
  const exempt = new Set(exemptions.map((entry) => entry.identifier));
  const found = new Set(violations.map((violation) => violation.identifier));
  return {
    unexempted: violations.filter((violation) => !exempt.has(violation.identifier)),
    stale: exemptions
      .filter((entry) => !found.has(entry.identifier))
      .map((entry) => `stale_identifier_exemption: ${entry.identifier}`),
  };
}

/**
 * Every protected-column name that does not resolve to a real drizzle
 * property, plus how many names were checked.
 *
 * `publicColumns` (`@oxyhq/db/assert`) filters by SET MEMBERSHIP —
 * `new Set(registry[table])` — so a name matching no property is silently
 * ignored: it protects nothing, `tsc` is clean (the registry is a plain
 * `as const` string tuple), and no existing gate looks at it. A single typo
 * (`rawTagsOriginalBytelength`) therefore un-protects a server-only column
 * with no failure anywhere. Task 5 tripled this registry, which is what makes
 * binding it to real columns worth a gate.
 *
 * The `scanned` count is the vacuity floor: a traversal that silently checks
 * nothing (a renamed registry, a broken `Object.entries`) reports zero
 * violations exactly like a clean one.
 */
function findUnboundProtectedColumns(): { violations: string[]; scanned: number } {
  const byName = new Map(tables().map((table) => [getTableConfig(table).name, table]));
  const violations: string[] = [];
  let scanned = 0;

  for (const [tableName, properties] of Object.entries(PROTECTED_COLUMNS_BY_TABLE)) {
    const table = byName.get(tableName);
    if (!table) {
      violations.push(`${tableName}: no table of that name is exported from the schema barrel`);
      continue;
    }
    const declared = new Set(Object.keys(getTableColumns(table)));
    for (const property of properties) {
      scanned += 1;
      if (!declared.has(property)) {
        violations.push(`${tableName}.${property}: no such drizzle property — protects nothing`);
      }
    }
  }
  return { violations, scanned };
}

/**
 * Assert a write is refused BY THE CONSTRAINT NAMED — not merely that it
 * throws.
 *
 * `.rejects.toThrow()` (the pattern the Task 2-4 blocks above use) passes on
 * ANY failure: a not-null violation from a fixture field somebody forgot, a
 * foreign key from a parent row that was not created, a value that happens to
 * trip a DIFFERENT check on the same table. It cannot tell "the constraint
 * under test fired" from "this test is broken", which is the shape of check
 * this project has been bitten by before. Naming the constraint closes that:
 * the assertion fails, and says which constraint DID fire, when the answer is
 * the wrong one.
 *
 * The predicates come from `@oxyhq/db` because drizzle WRAPS the driver error
 * — `code` and `constraint_name` live on `cause`, not on the error thrown, so
 * a hand-rolled `error.code === '23505'` here would match nothing and pass
 * vacuously.
 */
async function expectRefusedBy(
  query: Promise<unknown>,
  predicate: (error: unknown, constraintName?: string) => boolean,
  constraintName: string
): Promise<void> {
  let caught: unknown;
  let succeeded = false;
  try {
    await query;
    succeeded = true;
  } catch (error) {
    caught = error;
  }
  if (succeeded) {
    throw new Error(`expected "${constraintName}" to refuse this write, but it succeeded`);
  }
  expect(constraintNameOf(caught)).toBe(constraintName);
  expect(predicate(caught, constraintName)).toBe(true);
}

/**
 * Assert a column carries a foreign key pointing at a NAMED parent with a
 * NAMED `ON DELETE` — not merely that some key involves a column of that name.
 *
 * The weaker form is not hypothetical: Task 4's review mutation-tested it by
 * repointing a podcast subscription at `albums`, and the test stayed green.
 * Both halves are checked here, and the lookup reads `sqlColumnName(column)`
 * rather than `column.name` — the latter is the TypeScript property
 * (`houseId`), not the SQL name (`house_id`), so a comparison against it
 * matches nothing and passes vacuously.
 *
 * Task 5 asserted this shape inline twice; Task 6 needs it seven times, which
 * is where one named helper stops being an abstraction and starts being the
 * thing every caller would otherwise copy slightly differently.
 */
function expectForeignKey(
  table: PgTable,
  sqlColumn: string,
  parentTable: string,
  // `UpdateDeleteAction`, not `string`: drizzle's closed union is what makes a
  // typo'd `'set-null'` a compile error here rather than a test that can never
  // pass and is only discovered at runtime.
  onDelete: UpdateDeleteAction
): void {
  const fk = getTableConfig(table).foreignKeys.find((foreignKey) =>
    foreignKey.reference().columns.some((column) => sqlColumnName(column) === sqlColumn)
  );
  expect(fk).toBeDefined();
  // `toBeDefined()` does not narrow for TypeScript, and this repo bans `!`.
  if (!fk) throw new Error(`unreachable: no foreign key on ${sqlColumn}`);
  expect(getTableConfig(fk.reference().foreignTable).name).toBe(parentTable);
  expect(fk.onDelete).toBe(onDelete);
}

beforeAll(async () => {
  // Not `connectPostgres()` directly: `connectUnmanagedDb` resolves the url with
  // `TEST_DATABASE_URL` winning, and refuses a database that has not declared
  // itself disposable. Both rules now live there rather than being restated per
  // suite — which is what let two of the nine callers keep the WRONG precedence
  // (`||=`, i.e. `DATABASE_URL` wins) long after this file was fixed.
  //
  // Why the precedence is load-bearing, since the incident is worth keeping even
  // though the mechanism moved: `connectDb` OVERWRITES `process.env.DATABASE_URL`
  // with the test url, and `bun test` runs every file in one process — so which
  // database this suite read depended on whether a `test/postgres` suite happened
  // to run first. Same command, same tree, different answer by file ordering,
  // measured at 30 pass / 48 fail when this file went first against a stale
  // `DATABASE_URL`, with failures naming the schema under test rather than the
  // configuration that actually caused them.
  await connectUnmanagedDb();
});

afterAll(async () => {
  await closePostgres();
});

describe('schema gates', () => {
  it('classifies every id-shaped column', () => {
    const violations = findIdColumnViolations({
      tables: tables(),
      deferred: DEFERRED_FOREIGN_KEYS,
      withoutForeignKey: ID_COLUMNS_WITHOUT_FOREIGN_KEY,
      minimumTables: MINIMUM_TABLES,
    });
    expect(violations).toEqual([]);
  });

  it('has no implicit whole-row read of a protected table', async () => {
    // `src/`, not this file's own directory — the scan has to see every
    // consumer of a protected table, not just the ones under `db/`.
    const violations = await findImplicitWholeRowReads({
      sourceDir: join(__dirname, '..', '..'),
      registry: PROTECTED_COLUMNS_BY_TABLE,
    });
    expect(violations).toEqual([]);
  });

  it('keeps the migrated schema free of convention violations', async () => {
    const violations = await findSchemaInvariantViolations(getDb(), {
      minimumTables: MINIMUM_TABLES,
      minimumColumns: 0,
    });
    expect(violations).toEqual([]);
  });

  it('keeps every expiry sweep target indexed', async () => {
    const violations = await findUnsupportedExpiryColumns(getDb(), EXPIRY_SWEEP_TARGETS);
    expect(violations).toEqual([]);
  });

  it('binds every protected-column name to a real drizzle property', () => {
    const { violations, scanned } = findUnboundProtectedColumns();
    expect(violations).toEqual([]);
    // Vacuity floor: the walk must have examined every name the registry
    // holds, not merely "found nothing wrong".
    const declared = Object.values(PROTECTED_COLUMNS_BY_TABLE).reduce(
      (total, properties) => total + properties.length,
      0
    );
    expect(scanned).toBe(declared);
    // Raised from 14 by Task 6, which registered `rooms`' four internal
    // stream credentials, and from 20 by Task 7, which registered
    // `user_settings`' two privacy lists. Same rule as MINIMUM_TABLES: a floor
    // that never moves is a vacuity check that stopped checking.
    expect(scanned).toBeGreaterThanOrEqual(22);
  });

  it('declares no identifier Postgres would silently truncate', () => {
    const folder = findMigrationsFolder();
    const files = readdirSync(folder)
      .filter((entry) => entry.endsWith('.sql'))
      .map((entry) => ({ file: entry, text: readFileSync(join(folder, entry), 'utf8') }));

    // Vacuity floors: a broken glob or regex reports "no violations" exactly
    // like a clean schema does. Raised by Task 6 (11 -> 14 files, 400 -> 700
    // identifiers) and again by Task 7 (14 -> 15 files, 700 -> 850, against
    // 907 actual) for the same reason MINIMUM_TABLES is raised at every schema
    // task — a floor that never moves is a vacuity check that stopped
    // checking. 14, not 12, was Task 6's count because its review round added
    // the hand-split `0012`/`0013` pair, and 16, not 15, is Task 7's for the
    // same reason: its review round added `0015`. The identifier floor did NOT
    // move with it — `0015` only re-states two constraint names `0014` already
    // declared, so the distinct-identifier count is unchanged at 907. Task 13a
    // raises both again (16 -> 24 files, 850 -> 900, against 925 actual): its
    // `0022`/`0023` pair is the eighth and ninth migration to land since Task 7
    // set these, and eight of the nine went in without either floor moving —
    // which is the same "routine maintenance that is routinely forgotten" lapse
    // `migrate.ts` records for `LAST_GENESIS_MIGRATION_TAG`, and it fails just
    // as silently, in the safe direction.
    // Raised again by the podcast-visibility task (24 -> 28 files, 900 -> 1000,
    // against 1002 actual — four migrations landed since Task 13a set these and
    // none of them moved either floor). Same rule as MINIMUM_TABLES and for the
    // same reason the comment above gives at length: a floor that never moves is
    // a vacuity check that has stopped checking, and it fails silently in the
    // safe direction. `0027` itself adds two of those identifiers, the column
    // and its CHECK.
    expect(files.length).toBeGreaterThanOrEqual(28);
    const { violations, scanned } = findOverlongIdentifiers(files);
    expect(scanned).toBeGreaterThanOrEqual(1000);

    // Exact identity, never substring — see `findUnexemptedIdentifiers`.
    // The second half is the staleness check: an exemption that no longer
    // names an over-limit identifier is debt paid without anyone removing the
    // note, the same check `findIdColumnViolations` runs against its own two
    // ledgers.
    const { unexempted, stale } = findUnexemptedIdentifiers(violations, OVERLONG_IDENTIFIER_EXEMPTIONS);
    expect(unexempted).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('flags a 64-byte identifier and passes a 63-byte one', () => {
    // The checker's own proof, kept synthetic on purpose: the real scan above
    // reports one known violation forever, so it can never demonstrate that
    // the checker would catch a NEW one, nor that it stops at exactly the
    // right boundary. `a`.repeat(63) is the longest identifier Postgres
    // stores intact; 64 is the first it truncates.
    const ok = 'a'.repeat(MAX_IDENTIFIER_BYTES);
    const tooLong = 'b'.repeat(MAX_IDENTIFIER_BYTES + 1);
    const { violations, scanned } = findOverlongIdentifiers([
      {
        file: 'synthetic.sql',
        text: `ALTER TABLE "t" ADD CONSTRAINT "${tooLong}" CHECK ("${ok}" > 0);`,
      },
    ]);
    expect(violations).toEqual([{ identifier: tooLong, file: 'synthetic.sql', bytes: 64 }]);
    expect(scanned).toBe(3);
  });

  it('exempts an identifier by identity, never by substring', () => {
    // The defect this replaced: `violation.includes(entry.identifier)` against
    // the formatted message absorbed anything CONTAINING an exempt name, so a
    // brand-new over-limit identifier that happened to extend one passed the
    // gate — and kept the exemption looking live at the same time, defeating
    // the staleness check too. Both directions are asserted here, on synthetic
    // input, because the real scan holds one known violation forever and can
    // never demonstrate either.
    const exempt = 'x'.repeat(70);
    const superstring = `${exempt}_two`;
    const exemptions = [{ identifier: exempt, reason: 'synthetic' }];

    // The exempt name itself still passes, and nothing is reported stale.
    expect(
      findUnexemptedIdentifiers([{ identifier: exempt, file: 'a.sql', bytes: 70 }], exemptions)
    ).toEqual({ unexempted: [], stale: [] });

    // A superstring is a DIFFERENT identifier: it must be reported, and it
    // must not stand in for the exemption either.
    expect(
      findUnexemptedIdentifiers([{ identifier: superstring, file: 'b.sql', bytes: 74 }], exemptions)
    ).toEqual({
      unexempted: [{ identifier: superstring, file: 'b.sql', bytes: 74 }],
      stale: [`stale_identifier_exemption: ${exempt}`],
    });
  });
});

describe('catalog schema (Task 2)', () => {
  /** Every table `schema/catalog.ts` and `schema/genres.ts` promise, by SQL name. */
  const EXPECTED_TABLES = [
    'genres',
    'image_assets',
    'catalog_entities',
    'albums',
    'tracks',
    'track_credits',
    'track_sources',
    'track_hls_renditions',
    'catalog_entity_strikes',
    'album_genres',
    'album_sources',
    'catalog_entity_sources',
    'track_keys',
    'isrc_registry',
    'track_fingerprints',
    'lyrics',
    'lyrics_lines',
    'musicbrainz_artists',
    'musicbrainz_artist_urls',
    'discogs_releases',
  ];

  it('lands exactly the tables this task promises', () => {
    // Scoped to catalog.ts + genres.ts + trackKeys.ts, not the barrel-wide
    // `tables()` — see `tablesIn`'s own doc comment for why a per-task
    // exact-match check must never read the cumulative barrel. `track_keys`
    // moved to a module of its own in Task 13a (it references three verticals;
    // see that file), and is listed here rather than dropped from the expected
    // set, so the table stays covered by an exact-match gate somewhere.
    const present = tablesIn(catalogModule, genresModule, trackKeysModule)
      .map((table) => getTableConfig(table).name)
      .sort();
    expect(present).toEqual([...EXPECTED_TABLES].sort());
  });

  it('forbids linked_artist_id on a non-person catalog entity', async () => {
    const db = getDb();

    // A real `type: 'artist'` row is required first — the CHECK is what has
    // to reject the INSERT below, not a dangling foreign key. `source` is
    // required for a valid artist row (see the next test) — set it here so
    // this test only ever exercises the ONE constraint it names.
    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });

    try {
      // `Promise.resolve(...)`, not the bare query builder: a drizzle insert
      // builder is thenable but not an `instanceof Promise`, and bun:test's
      // `.rejects` matcher requires the latter — passed the bare builder it
      // reports "Expected promise, Received: PgInsertBase {...}" instead of
      // ever awaiting the query.
      await expect(
        Promise.resolve(
          db.insert(catalogEntities).values({
            name: 'CHECK-fixture-invalid',
            type: 'artist',
            source: 'upload',
            linkedArtistId: artist.id,
          })
        )
      ).rejects.toThrow();
    } finally {
      // `syra_dev` is a shared dev database other tasks also run migrations
      // and tests against — the fixture row must not survive the test, in
      // either the pass or the fail case.
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
    }
  });

  it('requires source on an artist catalog entity, but not on a person', async () => {
    const db = getDb();

    // Artist, no source: rejected.
    await expect(
      Promise.resolve(
        db.insert(catalogEntities).values({ name: 'CHECK-fixture-artist-no-source', type: 'artist' })
      )
    ).rejects.toThrow();

    // Person, no source: accepted — the CHECK must not tighten anything
    // Mongoose left open (persons never had a `source` field at all).
    const [person] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-person-no-source', type: 'person' })
      .returning({ id: catalogEntities.id });

    try {
      expect(person.id).toBeTruthy();
    } finally {
      await db.delete(catalogEntities).where(eq(catalogEntities.id, person.id));
    }
  });

  it('cascades a deleted track into track_hls_renditions — the corrected sibling of episode_hls_renditions', async () => {
    const db = getDb();

    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-hls-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const [track] = await db
      .insert(tracks)
      .values({
        title: 'CHECK-fixture-hls-track',
        artistId: artist.id,
        artistName: 'CHECK-fixture-hls-artist',
        duration: 180,
        source: 'upload',
      })
      .returning({ id: tracks.id });

    try {
      await db.insert(trackHlsRenditions).values({
        trackId: track.id,
        position: 0,
        manifestKey: 'CHECK-fixture-manifest-key',
        bitrateKbps: 128,
        encrypted: true,
      });

      await db.delete(tracks).where(eq(tracks.id, track.id));

      const remaining = await db
        .select()
        .from(trackHlsRenditions)
        .where(eq(trackHlsRenditions.trackId, track.id));
      expect(remaining).toEqual([]);
    } finally {
      // `tracks` is already gone by the time this runs on the pass path
      // (deleted above), so this is a no-op there — but on a FAILED
      // assertion `tracks`/`track_hls_renditions` rows would otherwise leak
      // into `syra_dev`, same as every other fixture in this describe block.
      await db.delete(trackHlsRenditions).where(eq(trackHlsRenditions.trackId, track.id));
      await db.delete(tracks).where(eq(tracks.id, track.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
    }
  });
});

describe('track_keys, one column per id space (Task 13a)', () => {
  /**
   * `track_keys` held one polymorphic `track_id` plus a `kind` naming which of
   * `tracks`/`user_uploads`/`episodes` it meant. Postgres has no conditional
   * foreign key, so nothing cascaded, and every caller deleting a parent had to
   * delete the key itself — which `services/uploads/expirySweeper.ts`, the one
   * that runs unattended, never did.
   *
   * The three tests below are the proof that the orphan is now structurally
   * impossible rather than merely absent: one per arm, each deleting the parent
   * through a plain `db.delete` (no application code involved at all) and
   * asserting the key row went with it. Each was mutation-checked by dropping
   * that arm's constraint on a live database and confirming the test fails
   * naming that arm — the two other arms stay green under the same mutation,
   * which is what makes each of the three load-bearing on its own.
   */

  async function seedTrack(marker: string): Promise<{ artistId: string; trackId: string }> {
    const db = getDb();
    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: `CHECK-fixture-${marker}-artist`, type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const [track] = await db
      .insert(tracks)
      .values({
        title: `CHECK-fixture-${marker}-track`,
        artistId: artist.id,
        artistName: `CHECK-fixture-${marker}-artist`,
        duration: 180,
        source: 'upload',
      })
      .returning({ id: tracks.id });
    return { artistId: artist.id, trackId: track.id };
  }

  it('cascades a deleted TRACK into its AES key', async () => {
    const db = getDb();
    const { artistId, trackId } = await seedTrack('key-track');

    try {
      await db
        .insert(trackKeys)
        .values({ trackId, keyHex: 'CHECK-fixture-key-hex', keyUri: 'CHECK-fixture-key-uri' });

      await db.delete(tracks).where(eq(tracks.id, trackId));

      expect(await db.select().from(trackKeys).where(eq(trackKeys.trackId, trackId))).toEqual([]);
    } finally {
      await db.delete(trackKeys).where(eq(trackKeys.trackId, trackId));
      await db.delete(tracks).where(eq(tracks.id, trackId));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artistId));
    }
  });

  it('cascades a deleted USER UPLOAD into its AES key — the sweeper path', async () => {
    // THE arm this task exists for. `services/uploads/expirySweeper.ts`
    // hard-deletes expired locker rows on a timer and never deleted the key;
    // this asserts the delete itself takes it, whoever issues the delete.
    const db = getDb();
    const [upload] = await db
      .insert(userUploads)
      .values({
        ownerOxyUserId: 'CHECK-fixture-key-upload-owner',
        title: 'CHECK-fixture-key-upload',
        duration: 210,
        sizeBytes: 1024,
        sha256: 'e'.repeat(64),
        status: 'ready',
      })
      .returning({ id: userUploads.id });

    try {
      await db
        .insert(trackKeys)
        .values({
          userUploadId: upload.id,
          keyHex: 'CHECK-fixture-key-hex',
          keyUri: 'CHECK-fixture-key-uri',
        });

      await db.delete(userUploads).where(eq(userUploads.id, upload.id));

      expect(
        await db.select().from(trackKeys).where(eq(trackKeys.userUploadId, upload.id))
      ).toEqual([]);
    } finally {
      await db.delete(trackKeys).where(eq(trackKeys.userUploadId, upload.id));
      await db.delete(userUploads).where(eq(userUploads.id, upload.id));
    }
  });

  it('cascades a deleted EPISODE into its AES key, and a deleted SHOW through it', async () => {
    // Two levels: `episodes.podcast_id` already cascaded from `podcasts`, so
    // once `track_keys.episode_id` cascades from `episodes` a deleted show
    // reaches the key as well. Asserted here because a two-level cascade is
    // exactly the kind of thing a reader assumes rather than checks.
    const db = getDb();
    const [podcast] = await db
      .insert(podcasts)
      .values({
        title: 'CHECK-fixture-key-show',
        feedUrl: 'https://example.test/check-fixture-key-show.xml',
        source: 'syra',
      })
      .returning({ id: podcasts.id });

    try {
      const [episode] = await db
        .insert(episodes)
        .values({
          podcastId: podcast.id,
          podcastTitle: 'CHECK-fixture-key-show',
          title: 'CHECK-fixture-key-episode',
          guid: 'CHECK-fixture-key-episode-guid',
          pubDate: new Date('2026-01-01T00:00:00.000Z'),
          source: 'syra',
        })
        .returning({ id: episodes.id });

      await db
        .insert(trackKeys)
        .values({
          episodeId: episode.id,
          keyHex: 'CHECK-fixture-key-hex',
          keyUri: 'CHECK-fixture-key-uri',
        });

      await db.delete(episodes).where(eq(episodes.id, episode.id));
      expect(
        await db.select().from(trackKeys).where(eq(trackKeys.episodeId, episode.id))
      ).toEqual([]);

      // Same again, deleted one level up.
      const [second] = await db
        .insert(episodes)
        .values({
          podcastId: podcast.id,
          podcastTitle: 'CHECK-fixture-key-show',
          title: 'CHECK-fixture-key-episode-2',
          guid: 'CHECK-fixture-key-episode-guid-2',
          pubDate: new Date('2026-01-02T00:00:00.000Z'),
          source: 'syra',
        })
        .returning({ id: episodes.id });
      await db
        .insert(trackKeys)
        .values({
          episodeId: second.id,
          keyHex: 'CHECK-fixture-key-hex',
          keyUri: 'CHECK-fixture-key-uri',
        });

      await db.delete(podcasts).where(eq(podcasts.id, podcast.id));
      expect(
        await db.select().from(trackKeys).where(eq(trackKeys.episodeId, second.id))
      ).toEqual([]);
    } finally {
      await db.delete(podcasts).where(eq(podcasts.id, podcast.id));
    }
  });

  it('refuses a key naming no parent, and a key naming two', async () => {
    // The CHECK is what makes the three columns a discriminated union rather
    // than three optional fields. Without it a row could name nothing (an
    // orphan by construction, reachable from no reader) or two parents at once
    // (deleting either would take a key the other still needs).
    const db = getDb();
    const { artistId, trackId } = await seedTrack('key-check');
    const [upload] = await db
      .insert(userUploads)
      .values({
        ownerOxyUserId: 'CHECK-fixture-key-check-owner',
        title: 'CHECK-fixture-key-check-upload',
        duration: 210,
        sizeBytes: 1024,
        sha256: 'f'.repeat(64),
        status: 'ready',
      })
      .returning({ id: userUploads.id });

    try {
      await expectRefusedBy(
        Promise.resolve(
          db.insert(trackKeys).values({ keyHex: 'CHECK-fixture-none', keyUri: 'none' })
        ),
        isCheckViolation,
        'track_keys_one_parent_check'
      );

      await expectRefusedBy(
        Promise.resolve(
          db.insert(trackKeys).values({
            trackId,
            userUploadId: upload.id,
            keyHex: 'CHECK-fixture-two',
            keyUri: 'two',
          })
        ),
        isCheckViolation,
        'track_keys_one_parent_check'
      );
    } finally {
      await db.delete(trackKeys).where(eq(trackKeys.trackId, trackId));
      await db.delete(userUploads).where(eq(userUploads.id, upload.id));
      await db.delete(tracks).where(eq(tracks.id, trackId));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artistId));
    }
  });

  it('refuses a second key on the same parent, per arm', async () => {
    // One unique per arm replaces the single unique the shared column carried.
    // A duplicate would make "the key for this record" ambiguous, and the
    // upsert in `storePackagedHls` relies on exactly this constraint to rotate
    // a key in place on re-ingest instead of inserting a second row.
    const db = getDb();
    const { artistId, trackId } = await seedTrack('key-unique');

    try {
      await db.insert(trackKeys).values({ trackId, keyHex: 'CHECK-fixture-first', keyUri: 'a' });
      await expectRefusedBy(
        Promise.resolve(
          db.insert(trackKeys).values({ trackId, keyHex: 'CHECK-fixture-second', keyUri: 'b' })
        ),
        isUniqueViolation,
        'track_keys_track_id_key'
      );
    } finally {
      await db.delete(trackKeys).where(eq(trackKeys.trackId, trackId));
      await db.delete(tracks).where(eq(tracks.id, trackId));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artistId));
    }
  });
});

describe('catalog dedup constraints (Task 19a)', () => {
  /**
   * The dedup keys the upload path relies on, asserted against POSTGRES.
   *
   * Every one of these was covered before — by `models/{Album,CatalogEntity,
   * Track}.test.ts`, against Mongoose. Those models' readers had all moved to
   * drizzle, so the assertions guarded schemas nothing queried: the same shape
   * as the `indexTrackAcoustically` twin Task 19a found next door. The
   * constraints themselves were declared here all along and had NO test.
   *
   * Deleting the model tests without moving these would have quietly dropped
   * the only statement anywhere that two releases cannot share a UPC.
   */

  /** Albums require a cover: `cover_art_id` is NOT NULL, so every fixture needs one. */
  async function seedCoverArt(marker: string): Promise<string> {
    const [asset] = await getDb()
      .insert(imageAssets)
      .values({
        s3Key: `CHECK-fixture-${marker}-key`,
        filename: `${marker}.jpg`,
        contentType: 'image/jpeg',
        byteSize: 1024,
        ownerType: 'album',
      })
      .returning({ id: imageAssets.id });
    return asset.id;
  }

  // NOT TESTED HERE, DELIBERATELY: `models/Album.test.ts` asserted "refuses to
  // create an album with no cover art". `albums.cover_art_id` is NOT NULL, so
  // drizzle's `$inferInsert` makes `coverArtId` a REQUIRED property — the
  // omission this would test does not compile. That is strictly stronger than
  // the Mongoose `required: true` it replaced (a runtime rejection), and it is
  // why every album fixture below carries a real `image_assets` row. Writing
  // the test would mean casting past the type that already prevents it.

  it('refuses two albums sharing a MusicBrainz release id, and lets NULLs coexist', async () => {
    const db = getDb();
    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-dedup-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const coverArtId = await seedCoverArt('dedup');

    // `release_date` is NOT NULL with no default — every album fixture carries
    // one, which the Mongoose equivalents never had to.
    const album = (title: string, extra: Record<string, string> = {}) => ({
      title,
      artistId: artist.id,
      artistName: 'CHECK-fixture-dedup-artist',
      releaseDate: '2020-01-01',
      coverArtId,
      ...extra,
    });

    try {
      await db.insert(albums).values(album('CHECK-fixture-mbid-1', { externalMusicbrainzReleaseId: 'mbid-x' }));
      await expectRefusedBy(
        Promise.resolve(
          db.insert(albums).values(album('CHECK-fixture-mbid-2', { externalMusicbrainzReleaseId: 'mbid-x' }))
        ),
        isUniqueViolation,
        'albums_external_musicbrainz_release_id_key'
      );

      // Dedup tier 2 is OPTIONAL: most releases carry no MBID at all, and a
      // unique index treats each NULL as distinct. If it did not, the second
      // album without an MBID would be refused and the catalogue would cap at
      // one unidentified release.
      await db.insert(albums).values(album('CHECK-fixture-no-mbid-1'));
      await db.insert(albums).values(album('CHECK-fixture-no-mbid-2'));
    } finally {
      await db.delete(albums).where(eq(albums.artistId, artist.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
      await db.delete(imageAssets).where(eq(imageAssets.id, coverArtId));
    }
  });

  it('refuses two albums sharing a UPC — dedup tier 1', async () => {
    const db = getDb();
    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-upc-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const coverArtId = await seedCoverArt('upc');

    try {
      await db.insert(albums).values({
        title: 'CHECK-fixture-upc-1',
        artistId: artist.id,
        artistName: 'CHECK-fixture-upc-artist',
        releaseDate: '2020-01-01',
        coverArtId,
        upc: 'CHECK-fixture-upc-value',
      });
      await expectRefusedBy(
        Promise.resolve(
          db.insert(albums).values({
            title: 'CHECK-fixture-upc-2',
            artistId: artist.id,
            artistName: 'CHECK-fixture-upc-artist',
            releaseDate: '2020-01-01',
            coverArtId,
            upc: 'CHECK-fixture-upc-value',
          })
        ),
        isUniqueViolation,
        'albums_upc_key'
      );
    } finally {
      await db.delete(albums).where(eq(albums.artistId, artist.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
      await db.delete(imageAssets).where(eq(imageAssets.id, coverArtId));
    }
  });

  it('scopes the name_key dedup to ARTISTS — a person may share a name', async () => {
    // The partial index (`where type = 'artist'`) is what makes this true, and
    // it is the whole reason artists and persons can share one table: a podcast
    // credit named "Sam Smith" must not collide with the recording artist.
    const db = getDb();
    const nameKey = 'check-fixture-shared-name-key';

    try {
      await db
        .insert(catalogEntities)
        .values({ name: 'CHECK-fixture Shared', nameKey, type: 'artist', source: 'upload' });

      await expectRefusedBy(
        Promise.resolve(
          db
            .insert(catalogEntities)
            .values({ name: 'CHECK-fixture Shared Again', nameKey, type: 'artist', source: 'upload' })
        ),
        isUniqueViolation,
        'catalog_entities_artist_name_key_key'
      );

      // Same key, type person — OUTSIDE the partial index, so accepted.
      const [person] = await db
        .insert(catalogEntities)
        .values({ name: 'CHECK-fixture Shared Person', nameKey, type: 'person' })
        .returning({ id: catalogEntities.id });
      expect(person.id).toBeTruthy();
    } finally {
      await db.delete(catalogEntities).where(eq(catalogEntities.nameKey, nameKey));
    }
  });

  it('refuses two entities linked to the same Oxy account, and to the same artist MBID', async () => {
    // Both are STRONG dedup keys — an identity claim, not a name guess — so a
    // duplicate is a merge bug rather than a coincidence.
    const db = getDb();
    const linkedOxyUserId = 'CHECK-fixture-linked-account';
    const mbid = 'CHECK-fixture-artist-mbid';

    try {
      await db
        .insert(catalogEntities)
        .values({ name: 'CHECK-fixture Linked', type: 'person', linkedOxyUserId });
      await expectRefusedBy(
        Promise.resolve(
          db
            .insert(catalogEntities)
            .values({ name: 'CHECK-fixture Linked 2', type: 'person', linkedOxyUserId })
        ),
        isUniqueViolation,
        'catalog_entities_linked_oxy_user_id_key'
      );

      await db.insert(catalogEntities).values({
        name: 'CHECK-fixture MBID',
        type: 'artist',
        source: 'upload',
        externalMusicbrainzArtistId: mbid,
      });
      await expectRefusedBy(
        Promise.resolve(
          db.insert(catalogEntities).values({
            name: 'CHECK-fixture MBID 2',
            type: 'artist',
            source: 'upload',
            externalMusicbrainzArtistId: mbid,
          })
        ),
        isUniqueViolation,
        'catalog_entities_external_musicbrainz_artist_id_key'
      );
    } finally {
      await db.delete(catalogEntities).where(eq(catalogEntities.linkedOxyUserId, linkedOxyUserId));
      await db.delete(catalogEntities).where(eq(catalogEntities.externalMusicbrainzArtistId, mbid));
    }
  });

  it('does NOT refuse two tracks sharing a content hash', async () => {
    // `tracks_sha256_idx` is deliberately NON-unique. The same audio legitimately
    // appears twice — a single and its album cut — and the hash is a dedup
    // SIGNAL the upload path weighs, not a constraint the database enforces. A
    // unique index here would reject the second upload outright.
    const db = getDb();
    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-sha-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });

    try {
      const track = (title: string) => ({
        title,
        artistId: artist.id,
        artistName: 'CHECK-fixture-sha-artist',
        duration: 180,
        source: 'upload' as const,
        sha256: 'c'.repeat(64),
      });
      await db.insert(tracks).values(track('CHECK-fixture-sha-1'));
      await db.insert(tracks).values(track('CHECK-fixture-sha-2'));

      const stored = await db.select().from(tracks).where(eq(tracks.artistId, artist.id));
      expect(stored).toHaveLength(2);
    } finally {
      await db.delete(tracks).where(eq(tracks.artistId, artist.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
    }
  });
});

describe('library and playlist schema (Task 3)', () => {
  /** Every table `schema/library.ts` promises, by SQL name. */
  const EXPECTED_TABLES = [
    'playlists',
    'playlist_tracks',
    'playlist_collaborators',
    'playlist_sources',
    'recently_played',
    'playback_states',
    'devices',
    'user_liked_tracks',
    'user_saved_albums',
    'user_followed_artists',
    'user_saved_playlists',
    'user_podcast_subscriptions',
  ];

  it('lands exactly the tables this task promises', () => {
    const present = tablesIn(libraryModule).map((table) => getTableConfig(table).name).sort();
    expect(present).toEqual([...EXPECTED_TABLES].sort());
  });

  it('has no Library table — five junctions carry its arrays instead', () => {
    const present = tablesIn(libraryModule).map((table) => getTableConfig(table).name);
    // `UserLibrary` (Mongo collection `userlibraries`) is gone entirely — not
    // renamed, not left as an empty shell.
    expect(present).not.toContain('libraries');
    expect(present).not.toContain('user_libraries');
    expect(present).not.toContain('user_library');
    // Its five arrays (`models/Library.ts:20-24`) each landed as their own
    // junction, one row per membership.
    expect(present).toEqual(
      expect.arrayContaining([
        'user_liked_tracks',
        'user_saved_albums',
        'user_followed_artists',
        'user_saved_playlists',
        'user_podcast_subscriptions',
      ])
    );
  });

  it('rejects a playback position below zero', async () => {
    const db = getDb();
    await expect(
      Promise.resolve(
        db.insert(playbackStates).values({ oxyUserId: 'CHECK-fixture-position-user', positionMs: -1 })
      )
    ).rejects.toThrow();
  });

  it('rejects a volume outside 0..1', async () => {
    const db = getDb();
    await expect(
      Promise.resolve(
        db.insert(playbackStates).values({ oxyUserId: 'CHECK-fixture-volume-user', volume: 1.5 })
      )
    ).rejects.toThrow();
  });

  it('cascades a deleted playlist into user_saved_playlists — the orphan RELATIONS.md found live in production', async () => {
    const db = getDb();

    // RELATIONS.md: playlists ARE hard-deleted (`deletePlaylist`), and the
    // Mongo path cleaned up `PlaylistTrack` but never `Library.savedPlaylists`
    // — a real orphan this CASCADE fixes without any application change. Task
    // 11 deleted the explicit cleanup along with the model, so the cascade
    // below is now the only thing doing it.
    const [playlist] = await db
      .insert(playlists)
      .values({
        name: 'CHECK-fixture-playlist',
        ownerOxyUserId: 'CHECK-fixture-owner',
        ownerUsername: 'CHECK-fixture-owner-name',
      })
      .returning({ id: playlists.id });

    await db
      .insert(userSavedPlaylists)
      .values({ oxyUserId: 'CHECK-fixture-saver', playlistId: playlist.id });

    await db.delete(playlists).where(eq(playlists.id, playlist.id));

    const remaining = await db
      .select()
      .from(userSavedPlaylists)
      .where(eq(userSavedPlaylists.playlistId, playlist.id));
    expect(remaining).toEqual([]);
  });

  it('indexes playlist_collaborators.oxy_user_id — the reverse direction getUserPlaylists\' $or needs', async () => {
    const db = getDb();
    // Verified against the MIGRATED catalogue, not the drizzle declaration —
    // a migration that dropped the index would fail this too.
    const rows = await executeRows<{ indexname: string }>(
      db,
      sql`select indexname from pg_indexes where tablename = 'playlist_collaborators'`
    );
    const names = rows.map((row) => row.indexname);
    expect(names).toContain('playlist_collaborators_oxy_user_id_idx');
    expect(names).toContain('playlist_collaborators_playlist_id_oxy_user_id_key');
  });
});

describe('podcasts schema (Task 4)', () => {
  /** Every table `schema/podcasts.ts` promises, by SQL name. */
  const EXPECTED_TABLES = [
    'podcasts',
    'podcast_funding',
    'podcast_persons',
    'podcast_sources',
    'podcast_categories',
    'episodes',
    'episode_transcripts',
    'episode_persons',
    'episode_hls_renditions',
    'episode_progress',
  ];

  it('lands exactly the tables this task promises', () => {
    const present = tablesIn(podcastsModule).map((table) => getTableConfig(table).name).sort();
    expect(present).toEqual([...EXPECTED_TABLES].sort());
  });

  it('closes the userPodcastSubscriptions.podcastId deferred entry', () => {
    // Task 3 landed userPodcastSubscriptions.podcastId as a plain column with
    // a deferred-ledger entry naming podcasts as its parent. Task 4 lands
    // podcasts, so that entry must be gone from the ledger AND the column
    // must now be a real declared foreign key — both halves of the same
    // change, checked independently so neither can be forgotten.
    //
    // This test asserted `remainingParents` EQUALLED `['copyright_reports']`
    // until Task 5, which landed that parent table and emptied the ledger.
    // The exact-match half moved to Task 5's own describe block (where the
    // emptiness is the thing being claimed); what belongs to Task 4 is that
    // `podcasts` is gone from the ledger and its column carries a real key,
    // which is what stays here. A per-task exact-match assertion against a
    // CUMULATIVE registry is the same trap `tablesIn` exists to avoid for
    // tables — recorded so the next task does not re-introduce it.
    const remainingParents = DEFERRED_FOREIGN_KEYS.map((fk) => fk.parentTable);
    expect(remainingParents).not.toContain('podcasts');

    // "An FK exists on this column" is a weaker claim than "the FK points at
    // `podcasts` and cascades" — which is what closing the ledger entry
    // actually means. Mutation-proven in review: repointing this FK at
    // `albums` left the previous version of this test green. Reads
    // `sqlColumnName(column)`, not `column.name` — the latter is the
    // TypeScript property (`podcastId`), not the SQL name (`podcast_id`);
    // `@oxyhq/db/src/casing.ts`'s own doc comment names this exact trap, and
    // it passed here only because no column in this schema is explicitly
    // named (`sqlColumnName` and `column.name` agree by coincidence, not by
    // correctness).
    const fk = getTableConfig(userPodcastSubscriptions).foreignKeys.find((foreignKey) =>
      foreignKey.reference().columns.some((column) => sqlColumnName(column) === 'podcast_id')
    );
    expect(fk).toBeDefined();
    // Non-null assertion would violate this repo's own ban on `!` — narrow
    // via the `toBeDefined()` above instead, which bun:test does not use to
    // narrow the type, so an explicit guard is still needed here.
    if (!fk) throw new Error('unreachable: asserted toBeDefined() above');
    expect(getTableConfig(fk.reference().foreignTable).name).toBe('podcasts');
    expect(fk.onDelete).toBe('cascade');
  });

  it('rejects a popularity outside 0..100 on podcasts and episodes', async () => {
    const db = getDb();
    await expect(
      Promise.resolve(
        db.insert(podcasts).values({
          title: 'CHECK-fixture-podcast',
          type: 'episodic',
          source: 'syra',
          status: 'active',
          popularity: 101,
        })
      )
    ).rejects.toThrow();

    // The episodes half of this test's own name: a schema that never
    // declared `episodes_popularity_check` would have passed this test
    // unchanged before this fix — the name promised coverage the body
    // didn't have. Needs a real parent podcast (episodes.podcast_id is
    // NOT NULL), so wrap in try/finally like this block's other tests.
    const [podcast] = await db
      .insert(podcasts)
      .values({ title: 'CHECK-fixture-popularity-podcast', type: 'episodic', source: 'syra', status: 'active' })
      .returning({ id: podcasts.id });

    try {
      await expect(
        Promise.resolve(
          db.insert(episodes).values({
            podcastId: podcast.id,
            podcastTitle: 'CHECK-fixture-popularity-podcast',
            title: 'CHECK-fixture-popularity-episode',
            guid: 'CHECK-fixture-popularity-guid',
            pubDate: new Date(),
            episodeType: 'full',
            source: 'syra',
            status: 'ready',
            popularity: 101,
          })
        )
      ).rejects.toThrow();
    } finally {
      await db.delete(podcasts).where(eq(podcasts.id, podcast.id));
    }
  });

  /**
   * `podcasts.visibility` — the CHECK, the DEFAULT, and the reason the DEFAULT
   * is the load-bearing half.
   *
   * The constraint is read out of `pg_constraint` rather than off the drizzle
   * declaration, so a migration that never created it fails here even though
   * `schema/podcasts.ts` says it should exist — the same reason every other
   * constraint assertion in this file goes to the catalogue.
   *
   * The DEFAULT is asserted because `0027` runs against a table full of
   * world-readable shows, and the RSS import path never names this column. Any
   * default but `'public'` hides the entire mirrored catalogue the moment the
   * migration lands, and nothing else in the repo would say so.
   */
  it('constrains podcasts.visibility and defaults it to public', async () => {
    const db = getDb();

    const constraints = await executeRows<{ conname: string }>(
      db,
      sql`select conname from pg_constraint
          where conrelid = 'podcasts'::regclass and contype = 'c'`
    );
    expect(constraints.map((row) => row.conname)).toContain('podcasts_visibility_check');

    // The CHECK rejects a value outside the ladder. Raw SQL, not a drizzle
    // insert: the column's TypeScript enum already makes an invalid literal a
    // compile error, so a typed insert could only test the type system.
    await expect(
      Promise.resolve(
        db.execute(sql`insert into podcasts (id, title, source, visibility)
                       values ('CHECK-fixture-visibility', 'CHECK-fixture', 'syra', 'secret')`)
      )
    ).rejects.toThrow();

    // And a row that says nothing about visibility is PUBLIC.
    const [row] = await db
      .insert(podcasts)
      .values({ title: 'CHECK-fixture-visibility-default', type: 'episodic', source: 'syra' })
      .returning({ id: podcasts.id, visibility: podcasts.visibility });

    try {
      expect(row?.visibility).toBe('public');
    } finally {
      if (row) await db.delete(podcasts).where(eq(podcasts.id, row.id));
    }
  });

  it('cascades a deleted podcast into user_podcast_subscriptions', async () => {
    const db = getDb();

    const [podcast] = await db
      .insert(podcasts)
      .values({ title: 'CHECK-fixture-cascade-podcast', type: 'episodic', source: 'syra', status: 'active' })
      .returning({ id: podcasts.id });

    await db
      .insert(userPodcastSubscriptions)
      .values({ oxyUserId: 'CHECK-fixture-subscriber', podcastId: podcast.id });

    await db.delete(podcasts).where(eq(podcasts.id, podcast.id));

    const remaining = await db
      .select()
      .from(userPodcastSubscriptions)
      .where(eq(userPodcastSubscriptions.podcastId, podcast.id));
    expect(remaining).toEqual([]);
  });

  it('joins podcasts to genres through podcast_categories, restricting genre deletion', async () => {
    const db = getDb();

    const [genre] = await db
      .insert(genres)
      .values({ name: 'CHECK-fixture-podcast-genre', kind: 'podcast' })
      .returning({ id: genres.id });
    const [podcast] = await db
      .insert(podcasts)
      .values({ title: 'CHECK-fixture-genre-podcast', type: 'episodic', source: 'syra', status: 'active' })
      .returning({ id: podcasts.id });

    try {
      await db.insert(podcastCategories).values({ podcastId: podcast.id, genreId: genre.id, position: 0 });

      // RESTRICT — the genre cannot be deleted while a podcast still
      // references it, matching album_genres' own treatment in catalog.ts.
      await expect(Promise.resolve(db.delete(genres).where(eq(genres.id, genre.id)))).rejects.toThrow();
    } finally {
      await db.delete(podcastCategories).where(eq(podcastCategories.podcastId, podcast.id));
      await db.delete(podcasts).where(eq(podcasts.id, podcast.id));
      await db.delete(genres).where(eq(genres.id, genre.id));
    }
  });

  it('rejects an album_genres row that points at a podcast-kind genre — the composite FK I7 exists for', async () => {
    const db = getDb();

    // The whole point of `genres.kind` + the composite `(genre_id, kind)`
    // FK: a single-column `genreId` FK could not stop `album_genres` (fixed
    // to `kind = 'music'` by its own CHECK) from referencing a genre row
    // that actually belongs to the podcast vertical. Needs a real `albums`
    // row to reference, which needs a real `catalog_entities` artist and a
    // real `image_assets` cover — see `genres.ts`'s file-level doc comment.
    const [genre] = await db
      .insert(genres)
      .values({ name: 'CHECK-fixture-cross-vertical-genre', kind: 'podcast' })
      .returning({ id: genres.id });
    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-cross-vertical-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const [coverArt] = await db
      .insert(imageAssets)
      .values({
        s3Key: 'CHECK-fixture-cross-vertical-cover-key',
        filename: 'cover.jpg',
        contentType: 'image/jpeg',
        byteSize: 1,
        ownerType: 'album',
      })
      .returning({ id: imageAssets.id });
    const [album] = await db
      .insert(albums)
      .values({
        title: 'CHECK-fixture-cross-vertical-album',
        artistId: artist.id,
        artistName: 'CHECK-fixture-cross-vertical-artist',
        releaseDate: '2026',
        coverArtId: coverArt.id,
      })
      .returning({ id: albums.id });

    try {
      // `kind` is omitted — `album_genres_kind_check` fixes it to `'music'`
      // by default, so this is exactly the row a real write path would
      // produce: an album genre insert that never mentions `kind` at all,
      // pointed at a genre row that is `kind = 'podcast'`.
      await expect(
        Promise.resolve(db.insert(albumGenres).values({ albumId: album.id, genreId: genre.id }))
      ).rejects.toThrow();
    } finally {
      await db.delete(albumGenres).where(eq(albumGenres.albumId, album.id));
      await db.delete(albums).where(eq(albums.id, album.id));
      await db.delete(imageAssets).where(eq(imageAssets.id, coverArt.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
      await db.delete(genres).where(eq(genres.id, genre.id));
    }
  });

  it('requires one episode per (podcast_id, guid)', async () => {
    const db = getDb();

    const [podcast] = await db
      .insert(podcasts)
      .values({ title: 'CHECK-fixture-guid-podcast', type: 'episodic', source: 'syra', status: 'active' })
      .returning({ id: podcasts.id });

    try {
      await db.insert(episodes).values({
        podcastId: podcast.id,
        podcastTitle: 'CHECK-fixture-guid-podcast',
        title: 'CHECK-fixture-episode',
        guid: 'CHECK-fixture-guid',
        pubDate: new Date(),
        episodeType: 'full',
        source: 'syra',
        status: 'ready',
      });

      await expect(
        Promise.resolve(
          db.insert(episodes).values({
            podcastId: podcast.id,
            podcastTitle: 'CHECK-fixture-guid-podcast',
            title: 'CHECK-fixture-episode-2',
            guid: 'CHECK-fixture-guid',
            pubDate: new Date(),
            episodeType: 'full',
            source: 'syra',
            status: 'ready',
          })
        )
      ).rejects.toThrow();
    } finally {
      await db.delete(episodes).where(eq(episodes.podcastId, podcast.id));
      await db.delete(podcasts).where(eq(podcasts.id, podcast.id));
    }
  });

  it('cascades a deleted episode into episode_progress', async () => {
    const db = getDb();

    const [podcast] = await db
      .insert(podcasts)
      .values({ title: 'CHECK-fixture-progress-podcast', type: 'episodic', source: 'syra', status: 'active' })
      .returning({ id: podcasts.id });
    const [episode] = await db
      .insert(episodes)
      .values({
        podcastId: podcast.id,
        podcastTitle: 'CHECK-fixture-progress-podcast',
        title: 'CHECK-fixture-progress-episode',
        guid: 'CHECK-fixture-progress-guid',
        pubDate: new Date(),
        episodeType: 'full',
        source: 'syra',
        status: 'ready',
      })
      .returning({ id: episodes.id });

    await db.insert(episodeProgress).values({ oxyUserId: 'CHECK-fixture-listener', episodeId: episode.id });

    await db.delete(podcasts).where(eq(podcasts.id, podcast.id));

    const remaining = await db
      .select()
      .from(episodeProgress)
      .where(eq(episodeProgress.episodeId, episode.id));
    expect(remaining).toEqual([]);
  });

  it('cascades a deleted episode into episode_hls_renditions — the table the commit-2 correction was about', async () => {
    // episode_hls_renditions had no behavioural test at all before this fix —
    // only a string in EXPECTED_TABLES — despite being one of the brief's
    // three explicitly-named Episode child tables and the shape that drove
    // catalog.ts's track_hls_renditions correction. This is its counterpart
    // to the Task 2 describe block's 'cascades a deleted track into
    // track_hls_renditions' test.
    const db = getDb();

    const [podcast] = await db
      .insert(podcasts)
      .values({ title: 'CHECK-fixture-hls-podcast', type: 'episodic', source: 'syra', status: 'active' })
      .returning({ id: podcasts.id });
    const [episode] = await db
      .insert(episodes)
      .values({
        podcastId: podcast.id,
        podcastTitle: 'CHECK-fixture-hls-podcast',
        title: 'CHECK-fixture-hls-episode',
        guid: 'CHECK-fixture-hls-guid',
        pubDate: new Date(),
        episodeType: 'full',
        source: 'syra',
        status: 'ready',
      })
      .returning({ id: episodes.id });

    try {
      await db.insert(episodeHlsRenditions).values({
        episodeId: episode.id,
        position: 0,
        manifestKey: 'CHECK-fixture-manifest-key',
        bitrateKbps: 128,
        encrypted: true,
      });

      await db.delete(episodes).where(eq(episodes.id, episode.id));

      const remaining = await db
        .select()
        .from(episodeHlsRenditions)
        .where(eq(episodeHlsRenditions.episodeId, episode.id));
      expect(remaining).toEqual([]);
    } finally {
      await db.delete(episodeHlsRenditions).where(eq(episodeHlsRenditions.episodeId, episode.id));
      await db.delete(episodes).where(eq(episodes.id, episode.id));
      await db.delete(podcasts).where(eq(podcasts.id, podcast.id));
    }
  });
});

describe('creators and uploads schema (Task 5)', () => {
  /** Every table `schema/creators.ts` promises, by SQL name. */
  const EXPECTED_TABLES = [
    'user_uploads',
    'user_upload_hls_renditions',
    'user_upload_provenance_markers',
    'artist_claims',
    'contribution_attestations',
    'contribution_attestation_provenance_markers',
    'contributor_standings',
    'contributor_strikes',
    'copyright_reports',
  ];

  it('lands exactly the tables this task promises', () => {
    const present = tablesIn(creatorsModule).map((table) => getTableConfig(table).name).sort();
    expect(present).toEqual([...EXPECTED_TABLES].sort());
  });

  it('closes the last deferred foreign key, leaving the ledger EMPTY', () => {
    // `tracks.copyrightReportId` was the ledger's only remaining entry after
    // Task 4. This task lands `copyright_reports`, so the entry must be
    // deleted AND the column must carry a real declared foreign key — both
    // halves checked independently so neither can be forgotten.
    //
    // The emptiness is asserted on the whole array rather than on the parent
    // names, because "the ledger is empty" is the actual claim: a future task
    // adding an entry has to come here and say so deliberately.
    expect(DEFERRED_FOREIGN_KEYS).toEqual([]);

    // Assert the TARGET and the ON DELETE, not merely that some foreign key
    // involves a column of this name — the weaker form survived a mutation
    // that repointed a podcast subscription at `albums` (Task 4 review).
    // `sqlColumnName(column)`, never `column.name`: the latter is the
    // TypeScript property (`copyrightReportId`), not the SQL name.
    const fk = getTableConfig(tracks).foreignKeys.find((foreignKey) =>
      foreignKey.reference().columns.some((column) => sqlColumnName(column) === 'copyright_report_id')
    );
    expect(fk).toBeDefined();
    if (!fk) throw new Error('unreachable: asserted toBeDefined() above');
    expect(getTableConfig(fk.reference().foreignTable).name).toBe('copyright_reports');
    expect(fk.onDelete).toBe('set null');
  });

  it('restricts deleting a track a copyright report names — DMCA evidence outlives the work', async () => {
    const db = getDb();

    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-report-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const [track] = await db
      .insert(tracks)
      .values({
        title: 'CHECK-fixture-report-track',
        artistId: artist.id,
        artistName: 'CHECK-fixture-report-artist',
        duration: 120,
        source: 'upload',
      })
      .returning({ id: tracks.id });
    const [report] = await db
      .insert(copyrightReports)
      .values({
        trackId: track.id,
        artistId: artist.id,
        reason: 'CHECK-fixture-reason',
      })
      .returning({ id: copyrightReports.id });

    try {
      // RESTRICT, not CASCADE: losing the track must not silently take the
      // report that explains why it went (RELATIONS.md).
      await expectRefusedBy(
        Promise.resolve(db.delete(tracks).where(eq(tracks.id, track.id))),
        isForeignKeyViolation,
        'copyright_reports_track_id_tracks_id_fk'
      );

      // And the report is what `tracks.copyright_report_id` points at, with
      // the SET NULL that closed the deferred ledger entry above.
      await db
        .update(tracks)
        .set({ copyrightReportId: report.id })
        .where(eq(tracks.id, track.id));
      await db.delete(copyrightReports).where(eq(copyrightReports.id, report.id));
      const [after] = await db
        .select({ copyrightReportId: tracks.copyrightReportId })
        .from(tracks)
        .where(eq(tracks.id, track.id));
      expect(after.copyrightReportId).toBeNull();
    } finally {
      await db.delete(copyrightReports).where(eq(copyrightReports.id, report.id));
      await db.delete(tracks).where(eq(tracks.id, track.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
    }
  });

  it('restricts deleting a track a contribution attestation names', async () => {
    const db = getDb();

    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-attestation-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const [track] = await db
      .insert(tracks)
      .values({
        title: 'CHECK-fixture-attestation-track',
        artistId: artist.id,
        artistName: 'CHECK-fixture-attestation-artist',
        duration: 120,
        source: 'upload',
      })
      .returning({ id: tracks.id });
    const [attestation] = await db
      .insert(contributionAttestations)
      .values({
        trackId: track.id,
        uploaderOxyUserId: 'CHECK-fixture-uploader',
        statement: 'CHECK-fixture-statement',
        acceptedAt: new Date(),
      })
      .returning({ id: contributionAttestations.id });

    try {
      await expectRefusedBy(
        Promise.resolve(db.delete(tracks).where(eq(tracks.id, track.id))),
        isForeignKeyViolation,
        'contribution_attestations_track_id_tracks_id_fk'
      );

      // The markers child table cascades from the attestation, so the
      // evidence stays whole or goes whole — never half.
      await db.insert(contributionAttestationProvenanceMarkers).values({
        contributionAttestationId: attestation.id,
        position: 0,
        code: 'CHECK-fixture-marker',
        weight: 'blocking',
      });
      await db.delete(contributionAttestations).where(eq(contributionAttestations.id, attestation.id));
      const remaining = await db
        .select()
        .from(contributionAttestationProvenanceMarkers)
        .where(eq(contributionAttestationProvenanceMarkers.contributionAttestationId, attestation.id));
      expect(remaining).toEqual([]);
    } finally {
      await db
        .delete(contributionAttestationProvenanceMarkers)
        .where(eq(contributionAttestationProvenanceMarkers.contributionAttestationId, attestation.id));
      await db.delete(contributionAttestations).where(eq(contributionAttestations.id, attestation.id));
      await db.delete(tracks).where(eq(tracks.id, track.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
    }
  });

  it('allows ONE attestation per contributed track, and one marker per position on each parent', async () => {
    const db = getDb();

    // RELATIONS.md: "one row per contributed track — the attestation belongs
    // to the publication, and a second publication of the same recording is a
    // second decision to defend". Both of these uniques could be dropped with
    // the rest of the suite still green, which is why they get their own test.
    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-unique-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const [track] = await db
      .insert(tracks)
      .values({
        title: 'CHECK-fixture-unique-track',
        artistId: artist.id,
        artistName: 'CHECK-fixture-unique-artist',
        duration: 120,
        source: 'upload',
      })
      .returning({ id: tracks.id });
    const [attestation] = await db
      .insert(contributionAttestations)
      .values({
        trackId: track.id,
        uploaderOxyUserId: 'CHECK-fixture-unique-uploader',
        statement: 'CHECK-fixture-unique-statement',
        acceptedAt: new Date(),
      })
      .returning({ id: contributionAttestations.id });
    const [upload] = await db
      .insert(userUploads)
      .values({
        ownerOxyUserId: 'CHECK-fixture-unique-owner',
        title: 'CHECK-fixture-unique-file',
        duration: 120,
        sizeBytes: 512,
        sha256: 'CHECK-fixture-unique-sha256',
      })
      .returning({ id: userUploads.id });

    try {
      await expectRefusedBy(
        Promise.resolve(
          db.insert(contributionAttestations).values({
            trackId: track.id,
            uploaderOxyUserId: 'CHECK-fixture-unique-uploader-2',
            statement: 'CHECK-fixture-unique-statement-2',
            acceptedAt: new Date(),
          })
        ),
        isUniqueViolation,
        'contribution_attestations_track_id_key'
      );

      // `position` is what preserves the Mongo array's ORDER in both markers
      // tables; two rows sharing one position on the same parent is an order
      // nobody can reconstruct.
      await db.insert(contributionAttestationProvenanceMarkers).values({
        contributionAttestationId: attestation.id,
        position: 0,
        code: 'CHECK-fixture-marker',
        weight: 'high',
      });
      await expectRefusedBy(
        Promise.resolve(
          db.insert(contributionAttestationProvenanceMarkers).values({
            contributionAttestationId: attestation.id,
            position: 0,
            code: 'CHECK-fixture-marker-again',
            weight: 'low',
          })
        ),
        isUniqueViolation,
        'contribution_attestation_provenance_markers_position_key'
      );

      await db.insert(userUploadProvenanceMarkers).values({
        userUploadId: upload.id,
        position: 0,
        code: 'CHECK-fixture-marker',
        weight: 'high',
      });
      await expectRefusedBy(
        Promise.resolve(
          db.insert(userUploadProvenanceMarkers).values({
            userUploadId: upload.id,
            position: 0,
            code: 'CHECK-fixture-marker-again',
            weight: 'low',
          })
        ),
        isUniqueViolation,
        'user_upload_provenance_markers_user_upload_id_position_key'
      );
    } finally {
      await db.delete(userUploadProvenanceMarkers).where(eq(userUploadProvenanceMarkers.userUploadId, upload.id));
      await db.delete(userUploads).where(eq(userUploads.id, upload.id));
      await db
        .delete(contributionAttestationProvenanceMarkers)
        .where(eq(contributionAttestationProvenanceMarkers.contributionAttestationId, attestation.id));
      await db.delete(contributionAttestations).where(eq(contributionAttestations.trackId, track.id));
      await db.delete(tracks).where(eq(tracks.id, track.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
    }
  });

  it('cascades a deleted standing into contributor_strikes, but a deleted TRACK only nulls the strike', async () => {
    const db = getDb();

    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-strike-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const [track] = await db
      .insert(tracks)
      .values({
        title: 'CHECK-fixture-strike-track',
        artistId: artist.id,
        artistName: 'CHECK-fixture-strike-artist',
        duration: 120,
        source: 'upload',
      })
      .returning({ id: tracks.id });
    const [standing] = await db
      .insert(contributorStandings)
      .values({ oxyUserId: 'CHECK-fixture-contributor' })
      .returning({ id: contributorStandings.id });

    try {
      const [strike] = await db
        .insert(contributorStrikes)
        .values({
          contributorStandingId: standing.id,
          reason: 'CHECK-fixture-strike-reason',
          trackId: track.id,
        })
        .returning({ id: contributorStrikes.id });

      // SET NULL: an infringement record must survive the work it is about,
      // or the repeat-infringer count silently drops (RELATIONS.md).
      await db.delete(tracks).where(eq(tracks.id, track.id));
      const [afterTrack] = await db
        .select({ trackId: contributorStrikes.trackId })
        .from(contributorStrikes)
        .where(eq(contributorStrikes.id, strike.id));
      expect(afterTrack.trackId).toBeNull();

      // CASCADE from the standing itself — the strike belongs to it.
      await db.delete(contributorStandings).where(eq(contributorStandings.id, standing.id));
      const remaining = await db
        .select()
        .from(contributorStrikes)
        .where(eq(contributorStrikes.id, strike.id));
      expect(remaining).toEqual([]);
    } finally {
      await db.delete(contributorStrikes).where(eq(contributorStrikes.contributorStandingId, standing.id));
      await db.delete(contributorStandings).where(eq(contributorStandings.id, standing.id));
      await db.delete(tracks).where(eq(tracks.id, track.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
    }
  });

  it('cascades a deleted artist into artist_claims, and allows one PENDING claim per claimant', async () => {
    const db = getDb();

    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-claim-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });

    try {
      await db.insert(artistClaims).values({
        artistId: artist.id,
        oxyUserId: 'CHECK-fixture-claimant',
        evidence: 'CHECK-fixture-evidence',
      });

      // Two OPEN claims by the same claimant on the same artist is the same
      // request reviewed twice — refused by the partial unique index.
      await expectRefusedBy(
        Promise.resolve(
          db.insert(artistClaims).values({
            artistId: artist.id,
            oxyUserId: 'CHECK-fixture-claimant',
            evidence: 'CHECK-fixture-evidence-again',
          })
        ),
        isUniqueViolation,
        'artist_claims_artist_id_oxy_user_id_pending_key'
      );

      // Resolved rows are OUTSIDE the index, so a claimant who was rejected
      // may come back with better evidence. This is the half a plain
      // `unique(artist_id, oxy_user_id)` would have silently forbidden, and
      // the reason the index is partial.
      await db.update(artistClaims).set({ status: 'rejected' }).where(eq(artistClaims.artistId, artist.id));
      const [reopened] = await db
        .insert(artistClaims)
        .values({
          artistId: artist.id,
          oxyUserId: 'CHECK-fixture-claimant',
          evidence: 'CHECK-fixture-evidence-appeal',
        })
        .returning({ id: artistClaims.id });
      expect(reopened.id).toBeTruthy();

      // A claim has no meaning without the artist it claims — CASCADE.
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
      const remaining = await db.select().from(artistClaims).where(eq(artistClaims.artistId, artist.id));
      expect(remaining).toEqual([]);
    } finally {
      await db.delete(artistClaims).where(eq(artistClaims.artistId, artist.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
    }
  });

  it('rejects claim evidence past the 4000-character limit Mongoose declared', async () => {
    const db = getDb();

    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-evidence-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });

    try {
      await expectRefusedBy(
        Promise.resolve(
          db.insert(artistClaims).values({
            artistId: artist.id,
            oxyUserId: 'CHECK-fixture-long-claimant',
            evidence: 'x'.repeat(4001),
          })
        ),
        isCheckViolation,
        'artist_claims_evidence_length_check'
      );

      // 4000 exactly is accepted — the boundary is `<=`, not `<`, so a CHECK
      // written one character tight would pass the rejection half above and
      // still be wrong.
      const [accepted] = await db
        .insert(artistClaims)
        .values({
          artistId: artist.id,
          oxyUserId: 'CHECK-fixture-long-claimant',
          evidence: 'x'.repeat(4000),
        })
        .returning({ id: artistClaims.id });
      expect(accepted.id).toBeTruthy();
    } finally {
      await db.delete(artistClaims).where(eq(artistClaims.artistId, artist.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
    }
  });

  it('keeps one copy of the same bytes per owner, and cascades an upload into its child tables', async () => {
    const db = getDb();

    const [upload] = await db
      .insert(userUploads)
      .values({
        ownerOxyUserId: 'CHECK-fixture-locker-owner',
        title: 'CHECK-fixture-locker-file',
        duration: 200,
        sizeBytes: 1024,
        sha256: 'CHECK-fixture-sha256',
      })
      .returning({ id: userUploads.id });

    try {
      // The unique index IS the duplicate detector — two concurrent uploads
      // of the same file are the ordinary case, and the E11000 (here, the
      // 23505) is what answers `{ outcome: 'duplicate' }`.
      await expectRefusedBy(
        Promise.resolve(
          db.insert(userUploads).values({
            ownerOxyUserId: 'CHECK-fixture-locker-owner',
            title: 'CHECK-fixture-locker-file-again',
            duration: 200,
            sizeBytes: 1024,
            sha256: 'CHECK-fixture-sha256',
          })
        ),
        isUniqueViolation,
        'user_uploads_owner_oxy_user_id_sha256_key'
      );

      // Another owner's copy of the same bytes is a different row — the
      // constraint is per-owner, and a plain `unique(sha256)` would have
      // rejected this one.
      const [other] = await db
        .insert(userUploads)
        .values({
          ownerOxyUserId: 'CHECK-fixture-other-owner',
          title: 'CHECK-fixture-locker-file-other',
          duration: 200,
          sizeBytes: 1024,
          sha256: 'CHECK-fixture-sha256',
        })
        .returning({ id: userUploads.id });
      await db.delete(userUploads).where(eq(userUploads.id, other.id));

      await db.insert(userUploadHlsRenditions).values({
        userUploadId: upload.id,
        position: 0,
        manifestKey: 'CHECK-fixture-manifest-key',
        bitrateKbps: 128,
        encrypted: true,
      });
      await db.insert(userUploadProvenanceMarkers).values({
        userUploadId: upload.id,
        position: 0,
        code: 'CHECK-fixture-marker',
        weight: 'high',
      });

      await db.delete(userUploads).where(eq(userUploads.id, upload.id));

      expect(
        await db
          .select()
          .from(userUploadHlsRenditions)
          .where(eq(userUploadHlsRenditions.userUploadId, upload.id))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(userUploadProvenanceMarkers)
          .where(eq(userUploadProvenanceMarkers.userUploadId, upload.id))
      ).toEqual([]);
    } finally {
      await db.delete(userUploadHlsRenditions).where(eq(userUploadHlsRenditions.userUploadId, upload.id));
      await db.delete(userUploadProvenanceMarkers).where(eq(userUploadProvenanceMarkers.userUploadId, upload.id));
      await db.delete(userUploads).where(eq(userUploads.id, upload.id));
    }
  });

  it('nulls a locker file\'s matched_track_id when the catalog track goes, keeping the file', async () => {
    const db = getDb();

    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-matched-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const [track] = await db
      .insert(tracks)
      .values({
        title: 'CHECK-fixture-matched-track',
        artistId: artist.id,
        artistName: 'CHECK-fixture-matched-artist',
        duration: 120,
        source: 'upload',
      })
      .returning({ id: tracks.id });
    const [upload] = await db
      .insert(userUploads)
      .values({
        ownerOxyUserId: 'CHECK-fixture-matched-owner',
        title: 'CHECK-fixture-matched-file',
        duration: 120,
        sizeBytes: 2048,
        sha256: 'CHECK-fixture-matched-sha256',
        matchedTrackId: track.id,
        resolvedArtistId: artist.id,
      })
      .returning({ id: userUploads.id });

    try {
      // "The locker copy is KEPT and pointed at the new track" — so losing
      // the track must not take the owner's own file with it.
      await db.delete(tracks).where(eq(tracks.id, track.id));
      const [after] = await db
        .select({ matchedTrackId: userUploads.matchedTrackId, resolvedArtistId: userUploads.resolvedArtistId })
        .from(userUploads)
        .where(eq(userUploads.id, upload.id));
      expect(after.matchedTrackId).toBeNull();
      expect(after.resolvedArtistId).toBe(artist.id);
    } finally {
      await db.delete(userUploads).where(eq(userUploads.id, upload.id));
      await db.delete(tracks).where(eq(tracks.id, track.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
    }
  });

  it('indexes the two sweeps and the purge that Mongo left to scan', async () => {
    const db = getDb();
    // Verified against the MIGRATED catalogue, not the drizzle declaration.
    // `deleted_at` and `matched_track_id` had NO Mongo index at all: the
    // expiry sweeper's phase-3 query (`deletedAt <= graceCutoff`) and the
    // takedown purge's `find({ matchedTrackId })` both scan the one
    // collection this design expects to reach millions of rows.
    const rows = await executeRows<{ indexname: string }>(
      db,
      sql`select indexname from pg_indexes where tablename = 'user_uploads'`
    );
    const names = rows.map((row) => row.indexname);
    expect(names).toContain('user_uploads_deleted_at_idx');
    expect(names).toContain('user_uploads_matched_track_id_idx');
    expect(names).toContain('user_uploads_expires_at_idx');
    expect(names).toContain('user_uploads_owner_oxy_user_id_sha256_key');
  });

  /**
   * `user_uploads.expires_at` looks exactly like a sweep target and must not be
   * one.
   *
   * `models/UserUpload.ts` declined a Mongo TTL index for a reason its own doc
   * comment spelled out — a blind row delete leaves every one of the file's S3
   * objects orphaned and skips the T−14d warning the retention policy promises
   * — and a test on that model asserted the absence. Task 13 deleted the model,
   * so the assertion moves here rather than disappearing with it: registering
   * this column would hand the column to `sweepExpiredRows`, which IS that
   * blind delete.
   */
  it('keeps user_uploads.expires_at OUT of the blind expiry sweep', () => {
    const swept = EXPIRY_SWEEP_TARGETS.map(
      (target) => `${getTableConfig(target.table).name}.${sqlColumnName(target.column)}`
    );
    expect(swept).not.toContain('user_uploads.expires_at');
    // Vacuity floor: an empty registry would satisfy the line above for the
    // wrong reason, and this gate would then never fail whatever was added.
    expect(swept.length).toBeGreaterThan(0);
  });

  it('keeps the locker-listing index NON-partial and the expiry index partial — the predicate, not just the name', async () => {
    const db = getDb();
    // `creators.ts` states that `user_uploads_owner_oxy_user_id_created_at_idx`
    // must stay NON-partial, because compliance's whole-locker purge
    // (`takedown.ts:509`, `find({ ownerOxyUserId })`) has to see soft-deleted
    // rows too — a `WHERE deleted_at is null` added here would "silently stop
    // serving" it. A test asserting only index NAMES cannot catch that: the
    // name is identical either way. So this asserts the DEFINITION, which is
    // the thing the comment actually promises.
    //
    // Both directions, because the two indexes on this table disagree on
    // purpose and an assertion that only forbids predicates would be equally
    // wrong: the expiry index IS partial, deliberately, since both sweeper
    // phases that read it filter `deletedAt: null`.
    const rows = await executeRows<{ indexname: string; indexdef: string }>(
      db,
      sql`select indexname, indexdef from pg_indexes where tablename = 'user_uploads'`
    );
    const definitions = new Map(rows.map((row) => [row.indexname, row.indexdef]));

    const listing = definitions.get('user_uploads_owner_oxy_user_id_created_at_idx');
    expect(listing).toBeDefined();
    expect(listing).toContain('(owner_oxy_user_id, created_at DESC NULLS LAST)');
    expect(listing).not.toContain('WHERE');

    const expiry = definitions.get('user_uploads_expires_at_idx');
    expect(expiry).toBeDefined();
    expect(expiry).toContain('WHERE (deleted_at IS NULL)');
  });
});

describe('rooms and live schema (Task 6)', () => {
  /** Every table `schema/rooms.ts` promises, by SQL name. */
  const EXPECTED_TABLES = [
    'houses',
    'house_members',
    'series',
    'series_episodes',
    'rooms',
    'room_media_queue_items',
    'recordings',
    'room_user_preferences',
  ];

  /**
   * Every `ON DELETE SET NULL` in `schema/rooms.ts`, as `[child table, fk
   * column]` — the set that needs a non-partial supporting index, since the
   * referential-integrity query Postgres runs for a SET NULL carries none of
   * the predicates the listing indexes are partial on.
   *
   * Declared once at describe scope and read by BOTH checks below — the
   * definition assertion and the planner probe — so the two can never disagree
   * about which relations they cover. The re-review caught exactly that drift
   * in its earlier form, where the definition loop named four of these five
   * while the schema's prose named a different four.
   */
  const SET_NULL_CHILDREN: readonly (readonly [string, string])[] = [
    ['rooms', 'house_id'],
    ['series', 'house_id'],
    ['rooms', 'series_id'],
    ['recordings', 'room_id'],
    ['series_episodes', 'room_id'],
  ];

  it('lands exactly the tables this task promises', () => {
    const present = tablesIn(roomsModule).map((table) => getTableConfig(table).name).sort();
    expect(present).toEqual([...EXPECTED_TABLES].sort());
  });

  it('drops Room.topicId rather than carrying a column pointing at no table', () => {
    // The decision this task existed to make: `models/Room.ts:224` declares
    // `ref: 'Topic'` and no `Topic` model exists anywhere in the repo. Both
    // halves are asserted, because either alone would pass while the other
    // was wrong: no `topic_id` column survived the port, AND no `topics`
    // table was invented to give it something to point at.
    const roomColumns = Object.values(getTableColumns(rooms)).map((column) => sqlColumnName(column));
    expect(roomColumns).not.toContain('topic_id');
    // `topic`, the free-text field, is a DIFFERENT and genuinely-used column
    // and must survive — without this the test would also pass against a port
    // that dropped both.
    expect(roomColumns).toContain('topic');

    const everyTable = tables().map((table) => getTableConfig(table).name);
    expect(everyTable).not.toContain('topics');

    // And no OTHER table smuggled the reference back in under a different
    // parent, which a rooms-only check could not see.
    const everyColumn = tables().flatMap((table) =>
      Object.values(getTableColumns(table)).map(
        (column) => `${getTableConfig(table).name}.${sqlColumnName(column)}`
      )
    );
    expect(everyColumn.filter((name) => name.endsWith('.topic_id'))).toEqual([]);
  });

  it('points every new foreign key at the parent and ON DELETE RELATIONS.md names', () => {
    // Target AND onDelete for all seven, not "a key exists" — see
    // `expectForeignKey`'s own doc comment for the mutation that motivated it.
    expectForeignKey(houseMembers, 'house_id', 'houses', 'cascade');
    expectForeignKey(series, 'house_id', 'houses', 'set null');
    expectForeignKey(rooms, 'house_id', 'houses', 'set null');
    expectForeignKey(rooms, 'series_id', 'series', 'set null');
    expectForeignKey(seriesEpisodes, 'series_id', 'series', 'cascade');
    expectForeignKey(seriesEpisodes, 'room_id', 'rooms', 'set null');
    expectForeignKey(roomMediaQueueItems, 'room_id', 'rooms', 'cascade');
    // The deliberate schema improvement: Mongoose says `required: true`, but
    // rooms are hard-deleted with no cleanup, so the column is relaxed to
    // nullable with SET NULL. See `schema/rooms.ts`'s file-level doc comment.
    expectForeignKey(recordings, 'room_id', 'rooms', 'set null');
    expect(getTableColumns(recordings).roomId.notNull).toBe(false);
  });

  it('keeps a recording when its room is deleted, and cascades the rest of the room away', async () => {
    const db = getDb();

    const [room] = await db
      .insert(rooms)
      .values({ title: 'CHECK-fixture-room', host: 'CHECK-fixture-host' })
      .returning({ id: rooms.id });
    const [recording] = await db
      .insert(recordings)
      .values({
        roomId: room.id,
        roomTitle: 'CHECK-fixture-room',
        host: 'CHECK-fixture-host',
        egressId: 'CHECK-fixture-egress',
        objectKey: 'CHECK-fixture-object-key',
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000),
      })
      .returning({ id: recordings.id });

    try {
      await db
        .insert(roomMediaQueueItems)
        .values({ roomId: room.id, position: 0, kind: 'track', trackId: 'CHECK-fixture-track' });

      await db.delete(rooms).where(eq(rooms.id, room.id));

      // The recording OUTLIVES its room — this is the whole point of relaxing
      // the column to nullable. CASCADE would have deleted recorded audio
      // because somebody tidied up a room.
      const [after] = await db
        .select({ roomId: recordings.roomId })
        .from(recordings)
        .where(eq(recordings.id, recording.id));
      expect(after.roomId).toBeNull();

      // The queue does NOT outlive it — an up-next list for a room that no
      // longer exists is nothing.
      const queue = await db
        .select()
        .from(roomMediaQueueItems)
        .where(eq(roomMediaQueueItems.roomId, room.id));
      expect(queue).toEqual([]);
    } finally {
      await db.delete(recordings).where(eq(recordings.id, recording.id));
      await db.delete(roomMediaQueueItems).where(eq(roomMediaQueueItems.roomId, room.id));
      await db.delete(rooms).where(eq(rooms.id, room.id));
    }
  });

  it('cascades a deleted house into its member roster, and only nulls its rooms and series', async () => {
    const db = getDb();

    const [house] = await db
      .insert(houses)
      .values({ name: 'CHECK-fixture-house', createdBy: 'CHECK-fixture-creator' })
      .returning({ id: houses.id });
    const [room] = await db
      .insert(rooms)
      .values({
        title: 'CHECK-fixture-house-room',
        host: 'CHECK-fixture-host',
        ownerType: 'house',
        houseId: house.id,
      })
      .returning({ id: rooms.id });
    const [show] = await db
      .insert(series)
      .values({
        title: 'CHECK-fixture-series',
        createdBy: 'CHECK-fixture-creator',
        houseId: house.id,
        recurrenceType: 'weekly',
        recurrenceTime: '09:30',
        roomTemplateTitlePattern: 'CHECK-fixture {n}',
      })
      .returning({ id: series.id });

    try {
      await db
        .insert(houseMembers)
        .values({ houseId: house.id, oxyUserId: 'CHECK-fixture-member', role: 'owner' });

      await db.delete(houses).where(eq(houses.id, house.id));

      // A membership in a house that no longer exists is nothing — CASCADE.
      expect(
        await db.select().from(houseMembers).where(eq(houseMembers.houseId, house.id))
      ).toEqual([]);

      /**
       * A room and a series both SURVIVE, which is the point of SET NULL over
       * a CASCADE that would destroy content.
       *
       * An earlier version of this comment called the result "the already-
       * meaningful profile-owned state". It is not, and the Task 6 review (I3)
       * was right to call that out: `owner_type` is untouched, so the room
       * lands at `owner_type = 'house'` with `house_id = null` — a combination
       * `RoomSchema.pre('validate')` (`models/Room.ts:352-355`) would refuse to
       * SAVE. That is asserted below rather than glossed, because it is the
       * open question this task handed back to the team lead: what SHOULD
       * happen to a house's rooms when the house is deleted.
       *
       * It fails closed in the meantime — `canManageRoom`
       * (`routes/rooms.routes.ts:151-154`) returns false on a missing houseId —
       * and the same state is already reachable today through a stale id.
       */
      const [roomAfter] = await db
        .select({ houseId: rooms.houseId, ownerType: rooms.ownerType })
        .from(rooms)
        .where(eq(rooms.id, room.id));
      expect(roomAfter.houseId).toBeNull();
      // The half that documents the open question: `owner_type` does NOT
      // follow. If a later change makes the FK reassign or cascade instead,
      // this line is what forces the decision to be made deliberately.
      expect(roomAfter.ownerType).toBe('house');
      const [seriesAfter] = await db
        .select({ houseId: series.houseId })
        .from(series)
        .where(eq(series.id, show.id));
      expect(seriesAfter.houseId).toBeNull();
    } finally {
      await db.delete(houseMembers).where(eq(houseMembers.houseId, house.id));
      await db.delete(rooms).where(eq(rooms.id, room.id));
      await db.delete(series).where(eq(series.id, show.id));
      await db.delete(houses).where(eq(houses.id, house.id));
    }
  });

  it('keeps a series episode when its generated room goes, but not when the series does', async () => {
    const db = getDb();

    const [show] = await db
      .insert(series)
      .values({
        title: 'CHECK-fixture-episode-series',
        createdBy: 'CHECK-fixture-creator',
        recurrenceType: 'daily',
        recurrenceTime: '07:00',
        roomTemplateTitlePattern: 'CHECK-fixture episode {n}',
      })
      .returning({ id: series.id });
    const [room] = await db
      .insert(rooms)
      .values({ title: 'CHECK-fixture-generated-room', host: 'CHECK-fixture-host', seriesId: show.id })
      .returning({ id: rooms.id });

    try {
      const [episode] = await db
        .insert(seriesEpisodes)
        .values({ seriesId: show.id, position: 0, roomId: room.id, scheduledStart: new Date(), episodeNumber: 1 })
        .returning({ id: seriesEpisodes.id });

      // RELATIONS.md: an append-only history of what the series scheduled.
      // Deleting one generated room must not erase the record that an episode
      // was ever scheduled — SET NULL, never CASCADE.
      await db.delete(rooms).where(eq(rooms.id, room.id));
      const [after] = await db
        .select({ roomId: seriesEpisodes.roomId })
        .from(seriesEpisodes)
        .where(eq(seriesEpisodes.id, episode.id));
      expect(after.roomId).toBeNull();

      // The series itself owns the log, though — CASCADE from that side.
      await db.delete(series).where(eq(series.id, show.id));
      expect(
        await db.select().from(seriesEpisodes).where(eq(seriesEpisodes.id, episode.id))
      ).toEqual([]);
    } finally {
      await db.delete(seriesEpisodes).where(eq(seriesEpisodes.seriesId, show.id));
      await db.delete(rooms).where(eq(rooms.id, room.id));
      await db.delete(series).where(eq(series.id, show.id));
    }
  });

  it('enforces the kind-to-id invariant models/Room.ts only asserted in a comment', async () => {
    const db = getDb();

    /**
     * `models/Room.ts:39-51` says "the parse/seed paths guarantee the right
     * fields are populated for each kind" — true of every writer, enforced by
     * nothing.
     *
     * FIVE directions, not four. The first version of this test claimed four
     * were enough and was wrong: dropping just `and ${t.trackId} is null` from
     * the PODCAST branch survived the entire suite, because all four fixtures
     * sat on the same side of the distinction that one conjunct makes (Task 6
     * review, I2). The shape that separates the strict CHECK from the loose
     * one is a `podcast` row smuggling a `track_id` — the exact mirror of the
     * `track`-smuggling-an-`episode_id` case this comment already singled out
     * as important, which is what makes the omission the classic "fixtures too
     * tidy" failure rather than a missing test nobody thought of.
     */
    const [room] = await db
      .insert(rooms)
      .values({ title: 'CHECK-fixture-queue-room', host: 'CHECK-fixture-host' })
      .returning({ id: rooms.id });

    try {
      // Accepted: the two shapes the parsers actually emit.
      await db.insert(roomMediaQueueItems).values({
        roomId: room.id,
        position: 0,
        kind: 'podcast',
        episodeId: 'CHECK-fixture-episode',
        syraPodcastId: 'CHECK-fixture-podcast',
      });
      await db
        .insert(roomMediaQueueItems)
        .values({ roomId: room.id, position: 1, kind: 'track', trackId: 'CHECK-fixture-track' });

      // Refused: a podcast row with no episode to play.
      await expectRefusedBy(
        Promise.resolve(
          db.insert(roomMediaQueueItems).values({ roomId: room.id, position: 2, kind: 'podcast' })
        ),
        isCheckViolation,
        'room_media_queue_items_kind_ids_check'
      );

      // Refused: a track row carrying podcast fields. This is the half a
      // positive-only CHECK would let through.
      await expectRefusedBy(
        Promise.resolve(
          db.insert(roomMediaQueueItems).values({
            roomId: room.id,
            position: 3,
            kind: 'track',
            trackId: 'CHECK-fixture-track-2',
            episodeId: 'CHECK-fixture-smuggled-episode',
          })
        ),
        isCheckViolation,
        'room_media_queue_items_kind_ids_check'
      );

      // Refused: the MIRROR — a podcast row smuggling a track_id. This is the
      // one case the first version of this test omitted, and the only fixture
      // that tells `... and track_id is null` from its absence. Verified by
      // mutation: without this insert, dropping that conjunct is green.
      await expectRefusedBy(
        Promise.resolve(
          db.insert(roomMediaQueueItems).values({
            roomId: room.id,
            position: 4,
            kind: 'podcast',
            episodeId: 'CHECK-fixture-episode-2',
            trackId: 'CHECK-fixture-smuggled-track',
          })
        ),
        isCheckViolation,
        'room_media_queue_items_kind_ids_check'
      );

      // And the queue order is a real constraint, not a convention: two rows
      // at one position is an order nobody can reconstruct, and this queue is
      // popped head-first.
      await expectRefusedBy(
        Promise.resolve(
          db
            .insert(roomMediaQueueItems)
            .values({ roomId: room.id, position: 0, kind: 'track', trackId: 'CHECK-fixture-dup' })
        ),
        isUniqueViolation,
        'room_media_queue_items_room_id_position_key'
      );
    } finally {
      await db.delete(roomMediaQueueItems).where(eq(roomMediaQueueItems.roomId, room.id));
      await db.delete(rooms).where(eq(rooms.id, room.id));
    }
  });

  it('allows one membership per user per house, and one preference row per user', async () => {
    const db = getDb();

    const [house] = await db
      .insert(houses)
      .values({ name: 'CHECK-fixture-unique-house', createdBy: 'CHECK-fixture-creator' })
      .returning({ id: houses.id });

    try {
      await db
        .insert(houseMembers)
        .values({ houseId: house.id, oxyUserId: 'CHECK-fixture-dup-member' });
      await expectRefusedBy(
        Promise.resolve(
          db
            .insert(houseMembers)
            .values({ houseId: house.id, oxyUserId: 'CHECK-fixture-dup-member', role: 'admin' })
        ),
        isUniqueViolation,
        'house_members_house_id_oxy_user_id_key'
      );

      await db.insert(roomUserPreferences).values({ oxyUserId: 'CHECK-fixture-pref-user' });
      await expectRefusedBy(
        Promise.resolve(
          db
            .insert(roomUserPreferences)
            .values({ oxyUserId: 'CHECK-fixture-pref-user', liveVisibility: 'speaking' })
        ),
        isUniqueViolation,
        'room_user_preferences_oxy_user_id_key'
      );
    } finally {
      await db.delete(houseMembers).where(eq(houseMembers.houseId, house.id));
      await db
        .delete(roomUserPreferences)
        .where(eq(roomUserPreferences.oxyUserId, 'CHECK-fixture-pref-user'));
      await db.delete(houses).where(eq(houses.id, house.id));
    }
  });

  it('refuses a second recording for one LiveKit egress job', async () => {
    const db = getDb();

    const [recording] = await db
      .insert(recordings)
      .values({
        roomTitle: 'CHECK-fixture-egress-room',
        host: 'CHECK-fixture-host',
        egressId: 'CHECK-fixture-egress-unique',
        objectKey: 'CHECK-fixture-object-key',
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000),
      })
      .returning({ id: recordings.id });

    try {
      // `Recording.findOne({ egressId })` is how the LiveKit egress webhook
      // finds the row it must update — two rows would make that lookup
      // nondeterministic.
      await expectRefusedBy(
        Promise.resolve(
          db.insert(recordings).values({
            roomTitle: 'CHECK-fixture-egress-room-2',
            host: 'CHECK-fixture-host',
            egressId: 'CHECK-fixture-egress-unique',
            objectKey: 'CHECK-fixture-object-key-2',
            startedAt: new Date(),
            expiresAt: new Date(Date.now() + 1000),
          })
        ),
        isUniqueViolation,
        'recordings_egress_id_key'
      );
    } finally {
      await db.delete(recordings).where(eq(recordings.id, recording.id));
    }
  });

  it('holds the participant bounds and the HH:mm recurrence shape Mongoose declared', async () => {
    const db = getDb();

    // Both boundaries, because a CHECK written one off (`< 10000` rather than
    // `<= 10000`) would pass a rejection-only test and still be wrong.
    await expectRefusedBy(
      Promise.resolve(
        db
          .insert(rooms)
          .values({ title: 'CHECK-fixture-bounds', host: 'CHECK-fixture-host', maxParticipants: 10001 })
      ),
      isCheckViolation,
      'rooms_max_participants_check'
    );
    await expectRefusedBy(
      Promise.resolve(
        db
          .insert(rooms)
          .values({ title: 'CHECK-fixture-bounds', host: 'CHECK-fixture-host', maxParticipants: 0 })
      ),
      isCheckViolation,
      'rooms_max_participants_check'
    );
    const [accepted] = await db
      .insert(rooms)
      .values({ title: 'CHECK-fixture-bounds-ok', host: 'CHECK-fixture-host', maxParticipants: 10000 })
      .returning({ id: rooms.id });

    try {
      expect(accepted.id).toBeTruthy();

      // `series.room_template_max_participants` carries the IDENTICAL bounds
      // from the same Mongoose declaration (`models/Series.ts:111-116`) and had
      // no test at all (Task 6 review, Minor 2) — two constraints from one
      // source, only one of them held.
      await expectRefusedBy(
        Promise.resolve(
          db.insert(series).values({
            title: 'CHECK-fixture-template-bounds',
            createdBy: 'CHECK-fixture-creator',
            recurrenceType: 'weekly',
            recurrenceTime: '09:30',
            roomTemplateTitlePattern: 'CHECK-fixture {n}',
            roomTemplateMaxParticipants: 10001,
          })
        ),
        isCheckViolation,
        'series_room_template_max_participants_check'
      );

      // `models/Series.ts:84`'s own `match: /^\d{2}:\d{2}$/`. Mongoose enforces
      // it on every save today, so a port that dropped it would silently
      // loosen validation the scheduling code still assumes.
      await expectRefusedBy(
        Promise.resolve(
          db.insert(series).values({
            title: 'CHECK-fixture-time',
            createdBy: 'CHECK-fixture-creator',
            recurrenceType: 'weekly',
            recurrenceTime: '9:30',
            roomTemplateTitlePattern: 'CHECK-fixture {n}',
          })
        ),
        isCheckViolation,
        'series_recurrence_time_check'
      );
    } finally {
      await db.delete(rooms).where(eq(rooms.id, accepted.id));
    }
  });

  it("enforces the two pre('validate') broadcast invariants Mongoose ran on every save", async () => {
    const db = getDb();
    /**
     * `RoomSchema.pre('validate')` (`models/Room.ts:344-360`) enforces three
     * invariants in application code. Task 6 ported 11 `maxlength`/`match`
     * declarations as CHECKs on the grounds that Mongoose enforces them on
     * every save — and then silently dropped these, which the review caught
     * (I3). Two are expressible without conflict and are now real constraints;
     * the third is not, for the reason recorded in the `houseId` column
     * comment and in this task's report.
     */
    // (1) A non-broadcast room may not carry a broadcastKind — the hook clears
    // it on every save (`models/Room.ts:349-351`).
    await expectRefusedBy(
      Promise.resolve(
        db.insert(rooms).values({
          title: 'CHECK-fixture-kind',
          host: 'CHECK-fixture-host',
          type: 'talk',
          broadcastKind: 'user',
        })
      ),
      isCheckViolation,
      'rooms_broadcast_kind_requires_type_check'
    );

    // (2) A broadcast room's speaker permission is forced to 'invited'
    // (`models/Room.ts:357-359`) — a broadcast is not a room anyone may speak in.
    await expectRefusedBy(
      Promise.resolve(
        db.insert(rooms).values({
          title: 'CHECK-fixture-permission',
          host: 'CHECK-fixture-host',
          type: 'broadcast',
          broadcastKind: 'user',
          speakerPermission: 'everyone',
        })
      ),
      isCheckViolation,
      'rooms_broadcast_speaker_permission_check'
    );

    // Two ACCEPTED shapes, so the CHECKs cannot be passing by forbidding
    // everything: a fully-specified broadcast room, and a broadcast room with
    // no kind at all. BOTH are broadcasts — an earlier version of this block
    // called the second one a "talk room" in its comment, its variable name and
    // its fixture title, none of which matched the row it actually inserted.
    // The talk-room shape is covered by check (1) above, which inserts
    // `type: 'talk'`.
    const [broadcastWithKind] = await db
      .insert(rooms)
      .values({
        title: 'CHECK-fixture-broadcast-ok',
        host: 'CHECK-fixture-host',
        type: 'broadcast',
        broadcastKind: 'agora',
        speakerPermission: 'invited',
      })
      .returning({ id: rooms.id });
    // A broadcast room with NO broadcastKind is deliberately still accepted:
    // Mongoose defaults it to 'user' rather than rejecting, and Postgres has no
    // per-row conditional default, so the converse CHECK would reject a write
    // the application makes legal. See the `broadcastKind` column comment.
    const [broadcastWithoutKind] = await db
      .insert(rooms)
      .values({
        title: 'CHECK-fixture-broadcast-no-kind-ok',
        host: 'CHECK-fixture-host',
        type: 'broadcast',
      })
      .returning({ id: rooms.id });

    try {
      expect(broadcastWithKind.id).toBeTruthy();
      expect(broadcastWithoutKind.id).toBeTruthy();
    } finally {
      await db.delete(rooms).where(eq(rooms.id, broadcastWithKind.id));
      await db.delete(rooms).where(eq(rooms.id, broadcastWithoutKind.id));
    }
  });

  it('keeps all five constraint-support indexes NON-partial and the five listing indexes partial', async () => {
    const db = getDb();
    // `schema/rooms.ts` states both properties in writing; a test asserting
    // only index NAMES cannot catch either, because the name is identical
    // whether or not a predicate is attached. So this asserts the DEFINITION,
    // against the MIGRATED catalogue rather than the drizzle declaration.
    const rows = await executeRows<{ indexname: string; indexdef: string }>(
      db,
      sql`select indexname, indexdef from pg_indexes
          where tablename in ('rooms', 'recordings', 'series', 'series_episodes')`
    );
    const definitions = new Map(rows.map((row) => [row.indexname, row.indexdef]));

    /**
     * The five that exist for an ON DELETE SET NULL, not for a query: a
     * predicate here would hide rows the constraint still has to find. One per
     * `ON DELETE SET NULL` in `schema/rooms.ts` — the list is ENUMERATED here
     * rather than counted in prose, so it cannot drift out of sync with a
     * number written somewhere else.
     *
     * This loop covered only the first TWO until the Task 6 review (I1), and
     * that gap is the reason the review exists. `rooms.house_id` and
     * `series.house_id` had no non-partial index at all — the schema claimed
     * the partial listing indexes doubled as constraint support, which a
     * partial index cannot do — so deleting a house sequential-scanned both
     * tables. Worse, the test asserted those two partial indexes CONTAINED
     * their predicate (below), so a reader trusting the gate read the defect
     * as verified. A gate that confirms the wrong property is worse than none.
     *
     * `series_episodes_room_id_idx` was the last one missing (re-review): it
     * was correctly built non-partial and correctly covered by the planner
     * probe below, but naming only four here left the definition check and the
     * schema's own prose disagreeing about the size of the set.
     */
    const constraintSupportIndexes = [
      'rooms_series_id_idx',
      'recordings_room_id_status_created_at_idx',
      'rooms_house_id_idx',
      'series_house_id_idx',
      'series_episodes_room_id_idx',
    ];
    for (const name of constraintSupportIndexes) {
      const definition = definitions.get(name);
      expect(definition).toBeDefined();
      expect(definition).not.toContain('WHERE');
    }
    // One index per SET NULL path — the planner probe walks the same relations
    // from the SAME list, so a new SET NULL that nobody indexed fails there
    // while this keeps the two honest about being the same size.
    expect(constraintSupportIndexes.length).toBe(SET_NULL_CHILDREN.length);

    // The five listing indexes, every one of which serves a query that opens
    // with `archived: { $ne: true }` unconditionally.
    const listingIndexes = [
      'rooms_status_created_at_idx',
      'rooms_house_id_status_created_at_idx',
      'rooms_host_status_created_at_idx',
      'rooms_type_status_created_at_idx',
      'rooms_owner_type_type_status_created_at_idx',
    ];
    for (const name of listingIndexes) {
      const definition = definitions.get(name);
      expect(definition).toBeDefined();
      expect(definition).toContain('WHERE (archived = false)');
    }
    // Vacuity floor: a typo'd table name in the query above would leave the
    // map empty and every `toBeDefined()` would be the only thing failing —
    // this makes a silently-narrowed scan fail by name instead.
    expect(definitions.size).toBeGreaterThanOrEqual(listingIndexes.length + 2);

    // The one partial index Mongo had no counterpart for at all: every LiveKit
    // webhook delivery does `findOne({ activeIngressId })` against an
    // unindexed column today.
    expect(definitions.get('rooms_active_ingress_id_idx')).toContain('WHERE (active_ingress_id IS NOT NULL)');
    expect(definitions.get('series_house_id_active_created_at_idx')).toContain('WHERE (is_active = true)');
  });

  it('lets every ON DELETE SET NULL find its rows by index, not by scanning', async () => {
    const db = getDb();
    /**
     * The direct test of the property I1 was about, and a strictly stronger one
     * than "the index carries no WHERE": it asks the PLANNER the same question
     * Postgres asks when a parent row is deleted. An index can be non-partial
     * and still not serve the query (wrong leading column), and a future
     * refactor could drop the index while leaving the definition assertion
     * above passing on the remaining ones.
     *
     * The query is the real referential-integrity probe Postgres runs for a
     * SET NULL — `select 1 from only <child> x where <fk> = $1 for key share
     * of x`. `enable_seqscan = off` makes this a question about USABILITY
     * rather than about cost estimates: these tables are empty, so a seq scan
     * is genuinely the cheapest plan and the planner picks it even when a
     * perfectly good index exists. With the setting off, any usable index
     * wins, so a remaining `Seq Scan` means no index could serve the query at
     * all. That is exactly how the review measured it.
     *
     * Run inside ONE transaction with `set local`, which is load-bearing twice
     * over. The setting must reach the same connection as the `explain` —
     * `getDb()` is a POOL, and a bare `set` could land on a different
     * connection, making this flaky. And `set local` unwinds at commit, so no
     * planner setting can leak onto a shared dev database even if the test
     * throws. The `show` assertion below refuses to let the whole thing pass
     * vacuously: without the setting every one of these probes returns a seq
     * scan (verified directly), so a silently-ineffective `set` would turn
     * this into a test that always fails rather than one that always passes —
     * but asserting it makes the reason unambiguous either way.
     */
    await db.transaction(async (tx) => {
      await executeRows(tx, sql`set local enable_seqscan = off`);
      const [setting] = await executeRows<{ enable_seqscan: string }>(
        tx,
        sql`show enable_seqscan`
      );
      expect(setting.enable_seqscan).toBe('off');

      for (const [table, column] of SET_NULL_CHILDREN) {
        const plan = await executeRows<{ 'QUERY PLAN': string }>(
          tx,
          sql`explain select 1 from only ${sql.identifier(table)} x
              where ${sql.identifier(column)} = 'probe' for key share of x`
        );
        const text = plan.map((row) => row['QUERY PLAN']).join('\n');
        // Named in the failure message, so a regression says WHICH deletion
        // path started scanning rather than just "expected false to be true".
        expect(`${table}.${column}: ${text.includes('Seq Scan') ? 'SEQ SCAN' : 'index'}`).toBe(
          `${table}.${column}: index`
        );
      }
    });
  });

  it('indexes the two arrays and the text search that have real readers', async () => {
    const db = getDb();
    // `recordings.participant_ids` is the ONE string array in this file with a
    // containment reader (`{ access: 'participants', participantIds: userId }`,
    // routes/rooms.routes.ts:2718); `rooms.participants`/`speakers`/`tags` have
    // none and deliberately get no GIN. Asserted against the migrated
    // catalogue so a dropped index fails here too.
    const rows = await executeRows<{ tablename: string; indexname: string }>(
      db,
      sql`select tablename, indexname from pg_indexes where tablename in ('rooms', 'recordings', 'houses')`
    );
    const names = rows.map((row) => row.indexname);
    expect(names).toContain('recordings_participant_ids_gin');
    expect(names).toContain('houses_search_gin');
    // The negative half: three arrays that were examined and deliberately left
    // unindexed. Without this the test would pass against a port that GIN'd
    // every array it saw, which is the opposite of the decision recorded.
    expect(names).not.toContain('rooms_participants_gin');
    expect(names).not.toContain('rooms_speakers_gin');
    expect(names).not.toContain('rooms_tags_gin');
  });

  it('protects the four room stream credentials, and only those', () => {
    // A leaked `rtmp_stream_key` is a WRITE capability — it lets a stranger
    // broadcast into someone else's room. The registry is the second guard
    // behind `PUBLIC_ROOM_FIELDS`; `findImplicitWholeRowReads` (asserted in
    // the gates block above) is what makes it bite.
    expect(PROTECTED_COLUMNS_BY_TABLE.rooms).toEqual([
      'rtmpStreamKey',
      'rtmpUrl',
      'activeStreamUrl',
      'activeIngressId',
    ]);
    // Every name resolves to a real column — `findUnboundProtectedColumns`
    // proves this schema-wide, but a typo here would un-protect a credential
    // silently, so the four are checked against the table by name too.
    const declared = new Set(Object.keys(getTableColumns(rooms)));
    for (const property of PROTECTED_COLUMNS_BY_TABLE.rooms) {
      expect(declared.has(property)).toBe(true);
    }
    // `recordings` is deliberately absent: `object_key` is a storage key, and
    // `catalog.ts` does not protect the identical `tracks.audio_source_key`.
    // Recorded as an assertion so a later task changing its mind has to change
    // this line and say why.
    expect(Object.keys(PROTECTED_COLUMNS_BY_TABLE)).not.toContain('recordings');
  });
});

describe('user, taste and listening schema (Task 7)', () => {
  /** Every table `schema/user.ts` promises, by SQL name. */
  const EXPECTED_TABLES = [
    'user_settings',
    'user_music_preferences',
    'user_behavior',
    'user_taste_profiles',
    'user_taste_genres',
    'user_taste_artists',
    'listening_events',
    'catalog_relations',
    'notification_preferences',
    'notification_suppressions',
  ];

  /**
   * Every foreign key this task declares, as `[child table, fk column, parent
   * table, ON DELETE]`.
   *
   * Declared once at describe scope and read by BOTH checks below — the
   * declaration assertion and the planner probe — for the same reason Task 6's
   * `SET_NULL_CHILDREN` is: two lists of the same relations drift, and the one
   * that drifts is always the one nobody re-reads. Every entry here is a
   * CASCADE, so the probe covers a different Postgres path than Task 6's did
   * (`RI_FKey_cascade_del` rather than `RI_FKey_setnull_del`) — the referential
   * lookup it makes on the child is the same shape, and an unindexed child
   * column costs a full scan of `listening_events`, the one table in this
   * schema designed to hold millions of rows.
   */
  const NEW_FOREIGN_KEYS: readonly (readonly [PgTable, string, string, UpdateDeleteAction])[] = [
    [listeningEvents, 'track_id', 'tracks', 'cascade'],
    [listeningEvents, 'artist_id', 'catalog_entities', 'cascade'],
    [userTasteGenres, 'taste_profile_id', 'user_taste_profiles', 'cascade'],
    [userTasteArtists, 'taste_profile_id', 'user_taste_profiles', 'cascade'],
    [userTasteArtists, 'artist_id', 'catalog_entities', 'cascade'],
  ];

  it('lands exactly the tables this task promises', () => {
    const present = tablesIn(userModule).map((table) => getTableConfig(table).name).sort();
    expect(present).toEqual([...EXPECTED_TABLES].sort());
  });

  it('registers every Mongo TTL index that was ported, with its own retention', () => {
    // `grep -rn "expireAfterSeconds" packages/backend/src` returns FOUR
    // declarations: these two, plus `ModerationOutbox` and `ModerationEvent`,
    // which are Task 8's. So this task lands two of the four — the brief's
    // prose says three, and its own table says two; the grep is what settles
    // it (see this task's report).
    //
    // Asserted as an exact, ordered list of `table.column:retentionSeconds`
    // rather than a length: a registry entry pointed at the wrong column, or
    // carrying the wrong retention, is exactly the mistake that leaves rows
    // either immortal or deleted 90 days early, and neither shows up as a
    // count.
    //
    // FOR TASK 8, SO A RED LINE HERE IS NOT MISREAD AS A REGRESSION: this
    // assertion is over the WHOLE registry, not this task's share of it, so
    // landing the two moderation entries turns it red on purpose. Add them to
    // the expected list (and move their rows in the walk above off
    // `DEFERRED_TO_TASK_8`) — that is the review this shape exists to force,
    // and it is deliberately not scoped away, because "a sweep target appeared
    // and nobody looked at its retention" is the failure the whole registry is
    // about.
    const registered = EXPIRY_SWEEP_TARGETS.map(
      (target) =>
        `${getTableConfig(target.table).name}.${sqlColumnName(target.column)}:${target.retentionSeconds}`
    );
    expect(registered).toEqual([
      // `expireAfterSeconds: 0` on a column that already holds the deadline.
      'notification_suppressions.expires_at:0',
      // `expireAfterSeconds: LISTENING_EVENT_TTL_SEC` — 90 days, measured from
      // a birth column.
      `listening_events.played_at:${90 * 24 * 60 * 60}`,
      // Task 8's two, and the review this shape exists to force has been done:
      // both were `expireAfterSeconds: 0` on an `expiresAt` the WRITER computes
      // from `MODERATION_*_RETENTION_SECONDS`, so 0 here is correct — the column
      // already IS the deadline, and the retention window lives in the package
      // where both of its backends read it. They arrive as a FRAGMENT
      // (`moderationExpirySweepTargets`) rather than as entries written in
      // `expiry.ts`, because `@oxyhq/crowdsource-app` is the only place that can
      // say what sweeping either one costs; the order below is that fragment's.
      'moderation_outbox.expires_at:0',
      'moderation_events.expires_at:0',
    ]);
  });

  it('gives each swept column its own supporting index, by name', async () => {
    const db = getDb();
    // `findUnsupportedExpiryColumns` (asserted in the schema-gates block above,
    // against this same migrated catalogue) is the general form of this check
    // and the one that will catch a FUTURE target added without an index. This
    // names the two indexes so a migration that dropped one fails HERE, saying
    // which — and so the general gate is not the only thing standing between
    // the sweep and a full scan of a table this design expects to reach
    // millions of rows.
    const rows = await executeRows<{ indexname: string }>(
      db,
      sql`select indexname from pg_indexes
          where tablename in ('listening_events', 'notification_suppressions')`
    );
    const names = rows.map((row) => row.indexname);
    expect(names).toContain('listening_events_played_at_idx');
    expect(names).toContain('notification_suppressions_expires_at_idx');
  });

  it('points every new foreign key at the parent and ON DELETE RELATIONS.md names', () => {
    // Target AND onDelete, never "a key exists on a column of this name" — see
    // `expectForeignKey`'s own doc comment for the mutation that motivated it.
    for (const [table, column, parent, onDelete] of NEW_FOREIGN_KEYS) {
      expectForeignKey(table, column, parent, onDelete);
    }
    // Vacuity floor: an empty or silently-truncated list would pass the loop
    // above by checking nothing.
    expect(NEW_FOREIGN_KEYS.length).toBe(5);
  });

  it('lets every new cascade and both expiry sweeps find rows by a LEADING-key index', async () => {
    const db = getDb();
    /**
     * The planner probe Task 6's I1 review introduced, applied to this task's
     * two index obligations at once — and strengthened, because Task 6's
     * spelling of it CANNOT CATCH THIS TASK'S DEFECTS. Mutation-tested both
     * ways before this version was written:
     *
     *   Dropping `user_taste_artists_artist_id_idx` from the real database
     *   left "the plan contains no `Seq Scan`" GREEN. With
     *   `enable_seqscan = off` the planner falls back to scanning the WHOLE of
     *   `user_taste_artists_taste_profile_id_artist_id_key` — a btree whose
     *   leading key is the other column — and pushes `artist_id = …` down as
     *   an `Index Cond` anyway (Postgres does this for non-leading keys). The
     *   plan says "Bitmap Index Scan", the cost triples, and a `Seq Scan` text
     *   test reads it as a pass. That is the same shape as the defect I1 was
     *   about: a check that certifies the thing it was supposed to refuse.
     *
     * So this asks the sharper question: does the planner use an index whose
     * LEADING key is the probed column — the property a Mongo index had by
     * construction and `findUnsupportedExpiryColumns` checks from `indkey[0]`?
     * The expected set comes from the catalogue, the actual index comes from
     * the plan, and both halves have to agree. An empty expected set fails on
     * its own, so a dropped index cannot pass by leaving nothing to compare.
     *
     * Two query shapes, because this task has two:
     *
     *  - The referential-integrity lookup Postgres runs on the CHILD when a
     *    parent row is deleted (`select 1 from only <child> x where <fk> = $1
     *    for key share of x`). Every new key here is `ON DELETE CASCADE`.
     *  - `sweepExpiredRows`' own inner statement (`select ctid from <table>
     *    where <column> <= now() - make_interval(...) limit <batch>`), walked
     *    from `EXPIRY_SWEEP_TARGETS` itself so a target added later without a
     *    usable index fails here too.
     *
     * `set local enable_seqscan = off` inside ONE transaction: these tables are
     * empty, so a seq scan genuinely is the cheapest plan and the planner would
     * pick it over a perfect index. `set local` also unwinds at commit, so no
     * planner setting can leak onto a shared dev database even if this throws.
     */
    const usedIndexes = (plan: readonly { 'QUERY PLAN': string }[]): string[] =>
      [...plan.map((row) => row['QUERY PLAN']).join('\n').matchAll(/Index (?:Only )?Scan (?:using|on) (\w+)/g)].map(
        (match) => match[1]
      );

    /** Every btree index whose FIRST key is `table.column` — `indkey[0]`, the same test the expiry gate makes. */
    const leadingKeyIndexes = async (
      executor: Parameters<typeof executeRows>[0],
      table: string,
      column: string
    ): Promise<string[]> => {
      const rows = await executeRows<{ indexname: string }>(
        executor,
        sql`select i.relname as indexname
            from pg_index x
            join pg_class i on i.oid = x.indexrelid
            join pg_class t on t.oid = x.indrelid
            join pg_am am on am.oid = i.relam
            join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
            where am.amname = 'btree' and t.relname = ${table} and a.attname = ${column}`
      );
      return rows.map((row) => row.indexname);
    };

    await db.transaction(async (tx) => {
      await executeRows(tx, sql`set local enable_seqscan = off`);
      const [setting] = await executeRows<{ enable_seqscan: string }>(tx, sql`show enable_seqscan`);
      expect(setting.enable_seqscan).toBe('off');

      for (const [table, column] of NEW_FOREIGN_KEYS) {
        const name = getTableConfig(table).name;
        const expected = await leadingKeyIndexes(tx, name, column);
        const plan = await executeRows<{ 'QUERY PLAN': string }>(
          tx,
          sql`explain select 1 from only ${sql.identifier(name)} x
              where ${sql.identifier(column)} = 'probe' for key share of x`
        );
        const used = usedIndexes(plan).filter((index) => expected.includes(index));
        // Named in the message, so a regression says WHICH deletion path
        // started scanning rather than "expected [] to have length 1".
        expect(`${name}.${column} served by: ${used.join(', ') || 'NO LEADING-KEY INDEX'}`).not.toContain(
          'NO LEADING-KEY INDEX'
        );
      }

      for (const target of EXPIRY_SWEEP_TARGETS) {
        const name = getTableConfig(target.table).name;
        const column = sqlColumnName(target.column);
        const expected = await leadingKeyIndexes(tx, name, column);
        const plan = await executeRows<{ 'QUERY PLAN': string }>(
          tx,
          sql`explain select ctid from ${sql.identifier(name)}
              where ${sql.identifier(column)} <= now() - make_interval(secs => ${sql.raw(
                String(target.retentionSeconds)
              )})
              limit 1000`
        );
        const used = usedIndexes(plan).filter((index) => expected.includes(index));
        expect(`sweep ${name}.${column} served by: ${used.join(', ') || 'NO LEADING-KEY INDEX'}`).not.toContain(
          'NO LEADING-KEY INDEX'
        );
      }
    });
  });

  it('cascades a listening event away with its track, and independently with its artist', async () => {
    const db = getDb();

    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-event-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    // A SECOND artist that owns no track. `tracks.artist_id` is RESTRICT
    // (RELATIONS.md: nothing ever deletes an artist), so deleting the track's
    // own artist is refused while the track exists — and deleting the track
    // first would take the event with it through the OTHER cascade, leaving
    // the artist key untested. Pointing the event's `artist_id` at an artist
    // that owns nothing is what isolates the two keys from each other.
    const [otherArtist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-event-other-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const [track] = await db
      .insert(tracks)
      .values({
        title: 'CHECK-fixture-event-track',
        artistId: artist.id,
        artistName: 'CHECK-fixture-event-artist',
        duration: 180,
        source: 'upload',
      })
      .returning({ id: tracks.id });

    try {
      const [viaArtist] = await db
        .insert(listeningEvents)
        .values({ oxyUserId: 'CHECK-fixture-listener', trackId: track.id, artistId: otherArtist.id })
        .returning({ id: listeningEvents.id });

      await db.delete(catalogEntities).where(eq(catalogEntities.id, otherArtist.id));
      expect(
        await db.select().from(listeningEvents).where(eq(listeningEvents.id, viaArtist.id))
      ).toEqual([]);

      const [viaTrack] = await db
        .insert(listeningEvents)
        .values({ oxyUserId: 'CHECK-fixture-listener', trackId: track.id, artistId: artist.id })
        .returning({ id: listeningEvents.id });

      await db.delete(tracks).where(eq(tracks.id, track.id));
      expect(
        await db.select().from(listeningEvents).where(eq(listeningEvents.id, viaTrack.id))
      ).toEqual([]);
    } finally {
      await db.delete(listeningEvents).where(eq(listeningEvents.trackId, track.id));
      await db.delete(tracks).where(eq(tracks.id, track.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, otherArtist.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
    }
  });

  it('holds the completion bounds at BOTH ends, and refuses a negative listened time', async () => {
    const db = getDb();

    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-completion-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const [track] = await db
      .insert(tracks)
      .values({
        title: 'CHECK-fixture-completion-track',
        artistId: artist.id,
        artistName: 'CHECK-fixture-completion-artist',
        duration: 180,
        source: 'upload',
      })
      .returning({ id: tracks.id });
    const event = { oxyUserId: 'CHECK-fixture-listener', trackId: track.id, artistId: artist.id };

    try {
      // `models/ListeningEvent.ts:82` declares `min: 0, max: 1`. BOTH ends,
      // because a CHECK written `completion <= 1` alone passes an
      // over-one-only test and still admits the negative that
      // `deriveCompletion` clamps against.
      await expectRefusedBy(
        Promise.resolve(db.insert(listeningEvents).values({ ...event, completion: 1.5 })),
        isCheckViolation,
        'listening_events_completion_check'
      );
      await expectRefusedBy(
        Promise.resolve(db.insert(listeningEvents).values({ ...event, completion: -0.1 })),
        isCheckViolation,
        'listening_events_completion_check'
      );
      await expectRefusedBy(
        Promise.resolve(db.insert(listeningEvents).values({ ...event, listenedSec: -1 })),
        isCheckViolation,
        'listening_events_listened_sec_check'
      );

      // The two boundary values are LEGAL — a full play and a zero-completion
      // skip are both ordinary rows, and a CHECK written one notch tight
      // (`< 1`) would pass every rejection above and still be wrong.
      const accepted = await db
        .insert(listeningEvents)
        .values([
          { ...event, completion: 1, listenedSec: 180 },
          { ...event, completion: 0, listenedSec: 0, skipped: true },
        ])
        .returning({ id: listeningEvents.id });
      expect(accepted).toHaveLength(2);
    } finally {
      await db.delete(listeningEvents).where(eq(listeningEvents.trackId, track.id));
      await db.delete(tracks).where(eq(tracks.id, track.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
    }
  });

  it('keeps one taste weight per key per profile — and the SAME key under another profile', async () => {
    const db = getDb();

    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-taste-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const [profile] = await db
      .insert(userTasteProfiles)
      .values({ oxyUserId: 'CHECK-fixture-taste-user' })
      .returning({ id: userTasteProfiles.id });
    const [otherProfile] = await db
      .insert(userTasteProfiles)
      .values({ oxyUserId: 'CHECK-fixture-taste-user-2' })
      .returning({ id: userTasteProfiles.id });

    try {
      await db.insert(userTasteGenres).values({ tasteProfileId: profile.id, genre: 'jazz', weight: 2 });
      await db
        .insert(userTasteArtists)
        .values({ tasteProfileId: profile.id, artistId: artist.id, weight: 3 });

      // `applyWeight` (`services/recommendations/recordPlay.ts:208`) finds the
      // existing entry by key and ADDS to it — one row per key is the
      // invariant the in-memory array held by construction and the child
      // tables have to hold for real.
      await expectRefusedBy(
        Promise.resolve(
          db.insert(userTasteGenres).values({ tasteProfileId: profile.id, genre: 'jazz', weight: 1 })
        ),
        isUniqueViolation,
        'user_taste_genres_taste_profile_id_genre_key'
      );
      await expectRefusedBy(
        Promise.resolve(
          db.insert(userTasteArtists).values({ tasteProfileId: profile.id, artistId: artist.id, weight: 1 })
        ),
        isUniqueViolation,
        'user_taste_artists_taste_profile_id_artist_id_key'
      );

      // The fixture that tells the composite key from a unique on the KEY
      // alone: two users are expected to like the same genre and the same
      // artist, and a `unique(genre)` / `unique(artist_id)` would pass every
      // rejection above while making the second listener's taste unwritable.
      const [sharedGenre] = await db
        .insert(userTasteGenres)
        .values({ tasteProfileId: otherProfile.id, genre: 'jazz', weight: 5 })
        .returning({ id: userTasteGenres.id });
      const [sharedArtist] = await db
        .insert(userTasteArtists)
        .values({ tasteProfileId: otherProfile.id, artistId: artist.id, weight: 5 })
        .returning({ id: userTasteArtists.id });
      expect(sharedGenre.id).toBeTruthy();
      expect(sharedArtist.id).toBeTruthy();

      // Losing the artist loses the learned weight — same disposable-aggregate
      // reasoning as `listening_events.artist_id` (RELATIONS.md), and the
      // genre row beside it is untouched because it references no catalog row
      // at all.
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
      expect(
        await db.select().from(userTasteArtists).where(eq(userTasteArtists.artistId, artist.id))
      ).toEqual([]);
      expect(
        await db.select().from(userTasteGenres).where(eq(userTasteGenres.tasteProfileId, profile.id))
      ).toHaveLength(1);

      // And the profile owns both children.
      await db.delete(userTasteProfiles).where(eq(userTasteProfiles.id, profile.id));
      expect(
        await db.select().from(userTasteGenres).where(eq(userTasteGenres.tasteProfileId, profile.id))
      ).toEqual([]);
    } finally {
      await db.delete(userTasteGenres).where(eq(userTasteGenres.tasteProfileId, profile.id));
      await db.delete(userTasteGenres).where(eq(userTasteGenres.tasteProfileId, otherProfile.id));
      await db.delete(userTasteArtists).where(eq(userTasteArtists.tasteProfileId, profile.id));
      await db.delete(userTasteArtists).where(eq(userTasteArtists.tasteProfileId, otherProfile.id));
      await db.delete(userTasteProfiles).where(eq(userTasteProfiles.id, profile.id));
      await db.delete(userTasteProfiles).where(eq(userTasteProfiles.id, otherProfile.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
    }
  });

  it('refuses a negative taste weight on either child and on the profile total', async () => {
    const db = getDb();

    // A REAL artist, not a made-up id: `user_taste_artists.artist_id` carries a
    // foreign key, and relying on the CHECK firing before the FK trigger would
    // make this test depend on Postgres's constraint evaluation order rather
    // than on the constraint it names.
    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-weight-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const [profile] = await db
      .insert(userTasteProfiles)
      .values({ oxyUserId: 'CHECK-fixture-weight-user' })
      .returning({ id: userTasteProfiles.id });

    try {
      // `models/UserTasteProfile.ts:42,52` declare `min: 0` on both the weight
      // and the total; `applyWeight` clamps at 0 on every path, so a negative
      // is a bug in a writer rather than a value anything should store.
      await expectRefusedBy(
        Promise.resolve(
          db.insert(userTasteGenres).values({ tasteProfileId: profile.id, genre: 'jazz', weight: -1 })
        ),
        isCheckViolation,
        'user_taste_genres_weight_check'
      );
      await expectRefusedBy(
        Promise.resolve(
          db
            .insert(userTasteArtists)
            .values({ tasteProfileId: profile.id, artistId: artist.id, weight: -1 })
        ),
        isCheckViolation,
        'user_taste_artists_weight_check'
      );
      await expectRefusedBy(
        Promise.resolve(
          db.insert(userTasteProfiles).values({ oxyUserId: 'CHECK-fixture-total', totalSignal: -1 })
        ),
        isCheckViolation,
        'user_taste_profiles_total_signal_check'
      );
    } finally {
      await db.delete(userTasteProfiles).where(eq(userTasteProfiles.id, profile.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
    }
  });

  it('allows one relation edge per (kind, source, target) — and the kind is part of that key', async () => {
    const db = getDb();
    const edge = { sourceId: 'CHECK-fixture-source', targetId: 'CHECK-fixture-target', score: 0.5 };

    try {
      await db.insert(catalogRelations).values({ ...edge, kind: 'artist' });
      await expectRefusedBy(
        Promise.resolve(db.insert(catalogRelations).values({ ...edge, kind: 'artist', score: 0.9 })),
        isUniqueViolation,
        'catalog_relations_kind_source_id_target_id_key'
      );

      // The fixture that distinguishes the three-column key from a
      // `unique(source_id, target_id)`: the same pair of ids means two
      // DIFFERENT edges under the two kinds, because `kind` decides which
      // table the ids even belong to (RELATIONS.md: polymorphic by `kind`).
      // Without this row, dropping `kind` from the key passes the whole suite.
      const [trackEdge] = await db
        .insert(catalogRelations)
        .values({ ...edge, kind: 'track' })
        .returning({ id: catalogRelations.id });
      expect(trackEdge.id).toBeTruthy();

      // Raw SQL, deliberately: drizzle's `{ enum: … }` type refuses `'podcast'`
      // at COMPILE time, which is a second and independent guard — but the
      // column is `text`, so Postgres accepts any string from a backfill, a
      // `sql` write, or a psql session. The CHECK is what makes the value set
      // true of the DATABASE rather than of this repo's TypeScript, and only a
      // write that bypasses the type can prove it exists.
      await expectRefusedBy(
        executeRows(
          db,
          sql`insert into catalog_relations (id, kind, source_id, target_id, score)
              values ('CHECK-fixture-bad-kind', 'podcast', ${edge.sourceId}, ${edge.targetId}, 0.5)`
        ),
        isCheckViolation,
        'catalog_relations_kind_check'
      );
      await expectRefusedBy(
        Promise.resolve(db.insert(catalogRelations).values({ ...edge, kind: 'artist', score: -1 })),
        isCheckViolation,
        'catalog_relations_score_check'
      );
    } finally {
      await db.delete(catalogRelations).where(eq(catalogRelations.sourceId, edge.sourceId));
    }
  });

  it('refuses a second suppression of one key for one user, but not the same key for another', async () => {
    const db = getDb();
    const expiresAt = new Date(Date.now() + 60_000);

    try {
      // `claimSuppression` (`services/notifications/notifier.ts:133`) INSERTS
      // and reads the duplicate-key error as "already notified" — the unique
      // index IS the decision, so this constraint is load-bearing logic rather
      // than hygiene.
      await db
        .insert(notificationSuppressions)
        .values({ oxyUserId: 'CHECK-fixture-recipient', key: 'episode.published:abc', expiresAt });
      await expectRefusedBy(
        Promise.resolve(
          db
            .insert(notificationSuppressions)
            .values({ oxyUserId: 'CHECK-fixture-recipient', key: 'episode.published:abc', expiresAt })
        ),
        isUniqueViolation,
        'notification_suppressions_oxy_user_id_key_key'
      );

      // Every subscriber of a show is suppressed under the SAME key — a
      // `unique(key)` would silence all but the first person notified, and
      // would pass the rejection above unchanged.
      const [other] = await db
        .insert(notificationSuppressions)
        .values({ oxyUserId: 'CHECK-fixture-recipient-2', key: 'episode.published:abc', expiresAt })
        .returning({ id: notificationSuppressions.id });
      expect(other.id).toBeTruthy();
    } finally {
      await db
        .delete(notificationSuppressions)
        .where(eq(notificationSuppressions.key, 'episode.published:abc'));
    }
  });

  it('refuses a disabled-events list naming an event that does not exist', async () => {
    const db = getDb();

    try {
      // Mongoose enforces the enum per element (`models/NotificationPreference
      // .ts:58`); an array column keeps that only if the CHECK does. Raw SQL
      // for the same reason as the `catalog_relations` kind above — the
      // TypeScript enum refuses this at compile time, the database is what has
      // to refuse it at run time.
      await expectRefusedBy(
        executeRows(
          db,
          sql`insert into notification_preferences (id, oxy_user_id, disabled_events)
              values ('CHECK-fixture-bad-event', 'CHECK-fixture-prefs',
                      array['episode.published', 'not.an.event']::text[])`
        ),
        isCheckViolation,
        'notification_preferences_disabled_events_check'
      );

      // Two accepted shapes, so the CHECK cannot be passing by forbidding
      // everything: a real event, and the empty list every user starts with
      // (`<@` is trivially true for an empty array — see `textArrayLiteral`).
      const accepted = await db
        .insert(notificationPreferences)
        .values([
          { oxyUserId: 'CHECK-fixture-prefs', disabledEvents: ['upload.expiring'] },
          { oxyUserId: 'CHECK-fixture-prefs-2' },
        ])
        .returning({ id: notificationPreferences.id });
      expect(accepted).toHaveLength(2);
    } finally {
      await db
        .delete(notificationPreferences)
        .where(inArray(notificationPreferences.oxyUserId, ['CHECK-fixture-prefs', 'CHECK-fixture-prefs-2']));
    }
  });

  it('refuses an active hour outside 0..23, at both ends', async () => {
    const db = getDb();

    try {
      // `models/UserBehavior.ts:38` declares `min: 0, max: 23` per element.
      // Both ends again: a CHECK containing only `0..23`'s upper half would
      // pass a 24-only test.
      await expectRefusedBy(
        Promise.resolve(
          db.insert(userBehavior).values({ oxyUserId: 'CHECK-fixture-behavior', activeHours: [24] })
        ),
        isCheckViolation,
        'user_behavior_active_hours_check'
      );
      await expectRefusedBy(
        Promise.resolve(
          db.insert(userBehavior).values({ oxyUserId: 'CHECK-fixture-behavior', activeHours: [-1] })
        ),
        isCheckViolation,
        'user_behavior_active_hours_check'
      );

      const [accepted] = await db
        .insert(userBehavior)
        .values({ oxyUserId: 'CHECK-fixture-behavior', activeHours: [0, 23] })
        .returning({ id: userBehavior.id });
      expect(accepted.id).toBeTruthy();
    } finally {
      await db.delete(userBehavior).where(eq(userBehavior.oxyUserId, 'CHECK-fixture-behavior'));
    }
  });

  it('holds every bounded setting at BOTH ends — all eight, not the two that were easy', async () => {
    const db = getDb();
    const settingsUser = 'CHECK-fixture-bounds-user';
    const playerUser = 'CHECK-fixture-player';

    /**
     * Every numeric bound Mongoose declared across `UserSettings` and
     * `UserMusicPreferences`, each with a value BELOW and a value ABOVE the
     * range plus both boundary values, driven from one table so a new bounded
     * column cannot be added with only the half of the test that was easy to
     * write.
     *
     * That is not a hypothetical: the first version of this block tested
     * `default_volume` and `crossfade` from ABOVE only, and the Task 7 review
     * (I1) mutation-proved it — rewriting both CHECKs as `<= 1` and `<= 12`
     * left every assertion here green while `default_volume = -1` became
     * storable. Two `it` blocks above, this same file already stated the rule
     * ("a CHECK written `completion <= 1` alone passes an over-one-only
     * test"). Stating a rule and then not applying it to the next pair of
     * columns is exactly what a table-driven fixture list prevents: the shape
     * of the data makes the omission visible.
     *
     * `build` closures rather than computed keys, so each row stays fully
     * typed against the table's own insert type instead of widening to an
     * index signature.
     */
    type SettingsPatch = Omit<typeof userSettings.$inferInsert, 'oxyUserId'>;
    type PlayerPatch = Omit<typeof userMusicPreferences.$inferInsert, 'oxyUserId'>;

    const SETTINGS_BOUNDS: readonly {
      readonly constraint: string;
      readonly source: string;
      readonly refuse: readonly number[];
      readonly accept: readonly number[];
      readonly build: (value: number) => SettingsPatch;
    }[] = [
      {
        constraint: 'user_settings_feed_diversity_same_author_penalty_check',
        source: 'models/UserSettings.ts:97 (min 0.5, max 1.0)',
        refuse: [0.4, 1.1],
        accept: [0.5, 1],
        build: (value) => ({ feedDiversitySameAuthorPenalty: value }),
      },
      {
        constraint: 'user_settings_feed_diversity_same_topic_penalty_check',
        source: 'models/UserSettings.ts:98 (min 0.5, max 1.0)',
        refuse: [0.49, 1.01],
        accept: [0.5, 1],
        build: (value) => ({ feedDiversitySameTopicPenalty: value }),
      },
      {
        constraint: 'user_settings_feed_diversity_max_consecutive_check',
        source: 'models/UserSettings.ts:99 (min 1, max 10)',
        refuse: [0, 11],
        accept: [1, 10],
        build: (value) => ({ feedDiversityMaxConsecutiveSameAuthor: value }),
      },
      {
        constraint: 'user_settings_feed_recency_half_life_hours_check',
        source: 'models/UserSettings.ts:102 (min 6, max 72)',
        refuse: [5, 73],
        accept: [6, 72],
        build: (value) => ({ feedRecencyHalfLifeHours: value }),
      },
      {
        constraint: 'user_settings_feed_recency_max_age_hours_check',
        source: 'models/UserSettings.ts:103 (min 24, max 336)',
        refuse: [23, 337],
        accept: [24, 336],
        build: (value) => ({ feedRecencyMaxAgeHours: value }),
      },
      {
        constraint: 'user_settings_feed_quality_min_engagement_rate_check',
        source: 'models/UserSettings.ts:106 (min 0, max 1)',
        refuse: [-0.1, 1.1],
        accept: [0, 1],
        build: (value) => ({ feedQualityMinEngagementRate: value }),
      },
    ];

    const PLAYER_BOUNDS: readonly {
      readonly constraint: string;
      readonly source: string;
      readonly refuse: readonly number[];
      readonly accept: readonly number[];
      readonly build: (value: number) => PlayerPatch;
    }[] = [
      {
        constraint: 'user_music_preferences_default_volume_check',
        source: 'models/UserMusicPreferences.ts:36 (min 0, max 1)',
        // `-0.1` is the fixture I1 was about: without it a `default_volume <= 1`
        // CHECK passes this whole block.
        refuse: [-0.1, 1.5],
        accept: [0, 1],
        build: (value) => ({ defaultVolume: value }),
      },
      {
        constraint: 'user_music_preferences_crossfade_check',
        source: 'models/UserMusicPreferences.ts:38 (min 0, max 12)',
        refuse: [-1, 13],
        accept: [0, 12],
        build: (value) => ({ crossfade: value }),
      },
    ];

    try {
      // One base row per table; the ACCEPTED values are applied as UPDATEs
      // against it, because `oxy_user_id` is unique and a second accepted
      // INSERT would fail for a reason that has nothing to do with the bound
      // under test.
      await db.insert(userSettings).values({ oxyUserId: settingsUser });
      await db.insert(userMusicPreferences).values({ oxyUserId: playerUser });

      for (const bound of SETTINGS_BOUNDS) {
        for (const value of bound.refuse) {
          await expectRefusedBy(
            Promise.resolve(
              db.update(userSettings).set(bound.build(value)).where(eq(userSettings.oxyUserId, settingsUser))
            ),
            isCheckViolation,
            bound.constraint
          );
        }
        for (const value of bound.accept) {
          await db
            .update(userSettings)
            .set(bound.build(value))
            .where(eq(userSettings.oxyUserId, settingsUser));
        }
      }

      for (const bound of PLAYER_BOUNDS) {
        for (const value of bound.refuse) {
          await expectRefusedBy(
            Promise.resolve(
              db
                .update(userMusicPreferences)
                .set(bound.build(value))
                .where(eq(userMusicPreferences.oxyUserId, playerUser))
            ),
            isCheckViolation,
            bound.constraint
          );
        }
        for (const value of bound.accept) {
          await db
            .update(userMusicPreferences)
            .set(bound.build(value))
            .where(eq(userMusicPreferences.oxyUserId, playerUser));
        }
      }

      // Both boundary values of every bound survived as real stored values —
      // an accepted UPDATE that silently matched no row would make the whole
      // `accept` half vacuous.
      const [stored] = await db
        .select({
          maxConsecutive: userSettings.feedDiversityMaxConsecutiveSameAuthor,
          minEngagement: userSettings.feedQualityMinEngagementRate,
        })
        .from(userSettings)
        .where(eq(userSettings.oxyUserId, settingsUser));
      expect(stored.maxConsecutive).toBe(10);
      expect(stored.minEngagement).toBe(1);

      // THE NULL FIXTURE, and the reason `0015` could drop the `is null or …`
      // branch from these two CHECKs: a Postgres CHECK passes when its
      // expression evaluates to NULL, so both nullable columns still accept an
      // absent value. Without this, the simplification rests on knowing that
      // rule rather than on the database demonstrating it.
      await db
        .update(userSettings)
        .set({ feedDiversityMaxConsecutiveSameAuthor: null, feedQualityMinEngagementRate: null })
        .where(eq(userSettings.oxyUserId, settingsUser));
      const [cleared] = await db
        .select({
          maxConsecutive: userSettings.feedDiversityMaxConsecutiveSameAuthor,
          minEngagement: userSettings.feedQualityMinEngagementRate,
        })
        .from(userSettings)
        .where(eq(userSettings.oxyUserId, settingsUser));
      expect(cleared.maxConsecutive).toBeNull();
      expect(cleared.minEngagement).toBeNull();

      // Vacuity floor: eight bounded columns, sixteen refusals, sixteen
      // accepted boundary values. A truncated table would pass every loop above
      // by iterating over less.
      expect(SETTINGS_BOUNDS.length + PLAYER_BOUNDS.length).toBe(8);
      expect(
        [...SETTINGS_BOUNDS, ...PLAYER_BOUNDS].every(
          (bound) => bound.refuse.length === 2 && bound.accept.length === 2
        )
      ).toBe(true);
    } finally {
      await db.delete(userSettings).where(eq(userSettings.oxyUserId, settingsUser));
      await db.delete(userMusicPreferences).where(eq(userMusicPreferences.oxyUserId, playerUser));
    }
  });

  it('refuses every out-of-set enum value, on all five text enums and the co-occurrence count', async () => {
    const db = getDb();
    /**
     * The five `text`-column enum CHECKs and `catalog_relations_co_count_check`
     * had no rejection fixture at all (Task 7 review, M1) — dropping any of
     * them would have left the suite green.
     *
     * Raw SQL for the five enums, for the reason spelled out on the two that
     * were already covered: drizzle's `{ enum: … }` refuses these values at
     * COMPILE time, which is a second and independent guard, but the column is
     * `text` and Postgres accepts any string from a backfill, a `sql` write or
     * a psql session. Only a write that bypasses TypeScript can prove the
     * database itself refuses them.
     */
    const [artist] = await db
      .insert(catalogEntities)
      .values({ name: 'CHECK-fixture-enum-artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const [track] = await db
      .insert(tracks)
      .values({
        title: 'CHECK-fixture-enum-track',
        artistId: artist.id,
        artistName: 'CHECK-fixture-enum-artist',
        duration: 120,
        source: 'upload',
      })
      .returning({ id: tracks.id });

    try {
      await expectRefusedBy(
        executeRows(
          db,
          sql`insert into user_settings (id, oxy_user_id, appearance_theme_mode)
              values ('CHECK-fixture-theme', 'CHECK-fixture-enum-user', 'neon')`
        ),
        isCheckViolation,
        'user_settings_theme_mode_check'
      );
      await expectRefusedBy(
        executeRows(
          db,
          sql`insert into user_settings (id, oxy_user_id, privacy_profile_visibility)
              values ('CHECK-fixture-visibility', 'CHECK-fixture-enum-user', 'secret')`
        ),
        isCheckViolation,
        'user_settings_profile_visibility_check'
      );
      await expectRefusedBy(
        executeRows(
          db,
          sql`insert into user_music_preferences (id, oxy_user_id, audio_quality)
              values ('CHECK-fixture-audio', 'CHECK-fixture-enum-user', 'lossless')`
        ),
        isCheckViolation,
        'user_music_preferences_audio_quality_check'
      );
      // `download_quality` is a SEPARATE constraint over the same value set —
      // one CHECK covering both columns is a plausible mistake that a fixture
      // on only one of them cannot see.
      await expectRefusedBy(
        executeRows(
          db,
          sql`insert into user_music_preferences (id, oxy_user_id, download_quality)
              values ('CHECK-fixture-download', 'CHECK-fixture-enum-user', 'lossless')`
        ),
        isCheckViolation,
        'user_music_preferences_download_quality_check'
      );
      await expectRefusedBy(
        executeRows(
          db,
          sql`insert into listening_events (id, oxy_user_id, track_id, artist_id, source)
              values ('CHECK-fixture-source', 'CHECK-fixture-enum-user', ${track.id}, ${artist.id}, 'telepathy')`
        ),
        isCheckViolation,
        'listening_events_source_check'
      );
      await expectRefusedBy(
        Promise.resolve(
          db.insert(catalogRelations).values({
            kind: 'artist',
            sourceId: 'CHECK-fixture-co-count-source',
            targetId: 'CHECK-fixture-co-count-target',
            score: 0.5,
            coCount: -1,
          })
        ),
        isCheckViolation,
        'catalog_relations_co_count_check'
      );

      // One accepted row per enum, so none of the six CHECKs can be passing by
      // forbidding everything.
      const [settings] = await db
        .insert(userSettings)
        .values({
          oxyUserId: 'CHECK-fixture-enum-user',
          appearanceThemeMode: 'dark',
          privacyProfileVisibility: 'followers_only',
        })
        .returning({ id: userSettings.id });
      const [player] = await db
        .insert(userMusicPreferences)
        .values({ oxyUserId: 'CHECK-fixture-enum-user', audioQuality: 'very_high', downloadQuality: 'low' })
        .returning({ id: userMusicPreferences.id });
      const [event] = await db
        .insert(listeningEvents)
        .values({
          oxyUserId: 'CHECK-fixture-enum-user',
          trackId: track.id,
          artistId: artist.id,
          source: 'radio',
        })
        .returning({ id: listeningEvents.id });
      const [relation] = await db
        .insert(catalogRelations)
        .values({
          kind: 'artist',
          sourceId: 'CHECK-fixture-co-count-source',
          targetId: 'CHECK-fixture-co-count-target',
          score: 0.5,
          coCount: 0,
        })
        .returning({ id: catalogRelations.id });
      expect([settings.id, player.id, event.id, relation.id].every(Boolean)).toBe(true);
    } finally {
      await db.delete(userSettings).where(eq(userSettings.oxyUserId, 'CHECK-fixture-enum-user'));
      await db
        .delete(userMusicPreferences)
        .where(eq(userMusicPreferences.oxyUserId, 'CHECK-fixture-enum-user'));
      await db
        .delete(catalogRelations)
        .where(eq(catalogRelations.sourceId, 'CHECK-fixture-co-count-source'));
      await db.delete(listeningEvents).where(eq(listeningEvents.trackId, track.id));
      await db.delete(tracks).where(eq(tracks.id, track.id));
      await db.delete(catalogEntities).where(eq(catalogEntities.id, artist.id));
    }
  });

  it('allows exactly one row per account on all five per-user tables', async () => {
    const db = getDb();
    const oxyUserId = 'CHECK-fixture-one-row-user';

    try {
      // Five separate Mongoose `unique: true` declarations on `oxyUserId`
      // (`UserSettings:112`, `UserMusicPreferences:35`, `UserBehavior:29`,
      // `UserTasteProfile:49`, `NotificationPreference:57`). Every reader of
      // all five is a `findOne({ oxyUserId })`, so a second row is a value
      // nobody can predict rather than a duplicate nobody notices.
      await db.insert(userSettings).values({ oxyUserId });
      await expectRefusedBy(
        Promise.resolve(db.insert(userSettings).values({ oxyUserId })),
        isUniqueViolation,
        'user_settings_oxy_user_id_key'
      );

      await db.insert(userMusicPreferences).values({ oxyUserId });
      await expectRefusedBy(
        Promise.resolve(db.insert(userMusicPreferences).values({ oxyUserId })),
        isUniqueViolation,
        'user_music_preferences_oxy_user_id_key'
      );

      await db.insert(userBehavior).values({ oxyUserId });
      await expectRefusedBy(
        Promise.resolve(db.insert(userBehavior).values({ oxyUserId })),
        isUniqueViolation,
        'user_behavior_oxy_user_id_key'
      );

      await db.insert(userTasteProfiles).values({ oxyUserId });
      await expectRefusedBy(
        Promise.resolve(db.insert(userTasteProfiles).values({ oxyUserId })),
        isUniqueViolation,
        'user_taste_profiles_oxy_user_id_key'
      );

      await db.insert(notificationPreferences).values({ oxyUserId });
      await expectRefusedBy(
        Promise.resolve(db.insert(notificationPreferences).values({ oxyUserId })),
        isUniqueViolation,
        'notification_preferences_oxy_user_id_key'
      );
    } finally {
      await db.delete(userSettings).where(eq(userSettings.oxyUserId, oxyUserId));
      await db.delete(userMusicPreferences).where(eq(userMusicPreferences.oxyUserId, oxyUserId));
      await db.delete(userBehavior).where(eq(userBehavior.oxyUserId, oxyUserId));
      await db.delete(userTasteProfiles).where(eq(userTasteProfiles.oxyUserId, oxyUserId));
      await db.delete(notificationPreferences).where(eq(notificationPreferences.oxyUserId, oxyUserId));
    }
  });

  it('protects the two privacy lists on user_settings, and only those', () => {
    // `GET /api/profile/settings/:userId` (`routes/profileSettings.ts:41`)
    // serves ANY user's whole settings document to any authenticated caller:
    // `ensureUserSettings` narrows the TYPE with `.lean<UserSettingsLean>()`
    // but never projects, so `privacy.hiddenWords` and `privacy.restrictedUsers`
    // — one person's muted words and the accounts they have restricted — are
    // already on the wire today. Registering them gives the Postgres port a
    // structural guard (`findImplicitWholeRowReads` refuses a bare
    // `db.select().from(userSettings)`) rather than leaving it to whoever ports
    // that route to remember. The route itself is Mongo-path code and is
    // raised in this task's report, not changed here.
    expect(PROTECTED_COLUMNS_BY_TABLE.user_settings).toEqual([
      'privacyHiddenWords',
      'privacyRestrictedUsers',
    ]);
    const declared = new Set(Object.keys(getTableColumns(userSettings)));
    for (const property of PROTECTED_COLUMNS_BY_TABLE.user_settings) {
      expect(declared.has(property)).toBe(true);
    }
    // The rest of `privacy` is deliberately NOT registered: the booleans and
    // `profileVisibility` describe how a profile renders to others, which is
    // the one part of this document a viewer is meant to see. Recorded as an
    // assertion so a later task changing its mind has to change this line.
    expect(PROTECTED_COLUMNS_BY_TABLE.user_settings).not.toContain('privacyProfileVisibility');
  });
});

describe('deploy-phase ordering (post-genesis)', () => {
  it('flags a pre migration ordered behind a post one, past the boundary', () => {
    // Pure/synthetic — proves the CHECKING LOGIC itself catches the exact
    // shape review Critical #1 found live on this branch (0003 "pre" behind
    // 0001/0002 "post"), without depending on the real journal ever
    // containing a violation to exercise it.
    const entries: { tag: string; phase: DeployPhase }[] = [
      { tag: 'boundary', phase: 'post' },
      { tag: 'after-1', phase: 'pre' },
      { tag: 'after-2', phase: 'post' },
      { tag: 'after-3', phase: 'pre' },
    ];
    const violations = findPostGenesisPhaseOrderingViolations(entries, 'boundary');
    expect(violations).toEqual(['after-3 is "pre" but is ordered behind "after-2" ("post").']);
  });

  it('reports no violations for a clean post-genesis sequence', () => {
    const entries: { tag: string; phase: DeployPhase }[] = [
      { tag: 'boundary', phase: 'post' },
      { tag: 'after-1', phase: 'pre' },
      { tag: 'after-2', phase: 'pre' },
      { tag: 'after-3', phase: 'post' },
    ];
    expect(findPostGenesisPhaseOrderingViolations(entries, 'boundary')).toEqual([]);
  });

  it('flags a boundary tag that is not in the journal at all', () => {
    const entries: { tag: string; phase: DeployPhase }[] = [{ tag: 'only-entry', phase: 'pre' }];
    expect(findPostGenesisPhaseOrderingViolations(entries, 'nonexistent-boundary')).toEqual([
      'boundary tag "nonexistent-boundary" is not present in the migration journal at all.',
    ]);
  });

  it('holds for the real journal, past LAST_GENESIS_MIGRATION_TAG', () => {
    // The live counterpart to the three synthetic tests above — reads the
    // REAL journal and the REAL migration files, exactly what
    // `bun run db:migrate` reads. Genesis (0000-0024) is exempt by
    // construction (see migrate.ts); this only holds every migration that
    // lands AFTER it to the invariant a real staged rollout needs.
    //
    // That post-genesis window WAS empty at cutover, because the boundary froze
    // at the newest migration the cutover applied. It is not empty any more:
    // `0025_powerful_famine` and `0026_supreme_hardball` landed on 2026-08-09,
    // so this test now holds real migrations to the invariant rather than
    // passing vacuously. Do not read the emptiness as a reason to delete it —
    // that reading is what an advanced boundary would manufacture permanently,
    // which is exactly why the boundary must never be advanced again. The three
    // synthetic tests above keep the CHECKER honest; the frozen-boundary pin
    // below keeps the INPUT honest.
    const folder = findMigrationsFolder();
    const journal = readJournal(folder);
    const { phases, problems } = readMigrationPhases(
      journal.map((entry) => entry.tag),
      folder
    );
    expect(problems).toEqual([]);

    const entries = journal.map((entry) => {
      const phase = phases.get(entry.tag);
      if (!phase) throw new Error(`unreachable: readMigrationPhases reported no problems for ${entry.tag}`);
      return { tag: entry.tag, phase };
    });

    expect(findPostGenesisPhaseOrderingViolations(entries, LAST_GENESIS_MIGRATION_TAG)).toEqual([]);
  });

  /**
   * THE BOUNDARY IS FROZEN, and this is what keeps it that way.
   *
   * Until cutover a test here required the opposite — that the boundary BE the
   * newest migration — because every migration landing before Syra's first
   * production Postgres deploy was genesis, so the tag had to advance with each
   * one, and routinely did not (it sat at `0015` while `0016`, `0017` and `0018`
   * landed; `migrate.ts` records the identical lapse one task earlier). Both
   * that test and `migrate.ts` said, in place, that cutover must DELETE it
   * rather than update it. Cutover happened on 2026-08-08 — 25 migrations
   * applied with `--phase=all`, `oxy-syra:9` live — so it is deleted, and this
   * stands in its place.
   *
   * The two tests are opposites for a reason, and the reason is asymmetric:
   * advancing the tag now would not weaken the ordering gate, it would SILENTLY
   * DELETE it. `findPostGenesisPhaseOrderingViolations` inspects only
   * `entries.slice(boundaryIndex + 1)`, so a boundary at the newest migration
   * leaves it an empty tail — no violations possible, forever, with every test
   * green. Nothing else in this file can notice that: "the boundary is a tag the
   * journal contains" still passes, and so does "holds for the real journal",
   * vacuously. A pin is the only shape that catches it.
   *
   * The tag is therefore written out here a SECOND time on purpose, which is the
   * one place in this file where duplicating a constant is correct. Reading it
   * from `LAST_GENESIS_MIGRATION_TAG` would compare the value to itself and pass
   * for every value it could ever hold.
   */
  it('LAST_GENESIS_MIGRATION_TAG is frozen at the cutover boundary', () => {
    /**
     * Carried in the compared VALUE so it reaches the failure output — whoever
     * hits this is mid-way through bumping the tag out of habit, and needs to be
     * told that the habit ended at cutover.
     */
    const remedy =
      'FROZEN at cutover (2026-08-08). Do NOT advance it: the post-genesis ' +
      'ordering gate inspects only the migrations AFTER this tag, so moving it ' +
      'to the newest migration makes that set empty and the pre-behind-post ' +
      'invariant checks nothing, forever, with every test green. A new migration ' +
      'is 0025+ and is meant to sit after this boundary and be checked.';

    expect(`${LAST_GENESIS_MIGRATION_TAG} | ${remedy}`).toBe(`0024_ambitious_xorn | ${remedy}`);
  });

  /**
   * The counterpart to the pin above: the pin proves the tag has not MOVED, this
   * proves the journal still contains what it names. A migration squashed,
   * renamed or removed from the journal would leave the boundary dangling, and
   * `findPostGenesisPhaseOrderingViolations` would then report it as an ordering
   * problem rather than as a bad constant.
   */
  it('the boundary is a tag the journal actually contains', () => {
    // A typo in the constant would otherwise satisfy nothing and be caught only
    // by `findPostGenesisPhaseOrderingViolations`'s own not-in-journal branch,
    // which reports it as an ordering problem rather than as a bad constant.
    const tags = readJournal(findMigrationsFolder()).map((entry) => entry.tag);
    expect(`${LAST_GENESIS_MIGRATION_TAG} in journal: ${tags.includes(LAST_GENESIS_MIGRATION_TAG)}`)
      .toBe(`${LAST_GENESIS_MIGRATION_TAG} in journal: true`);
  });
});
