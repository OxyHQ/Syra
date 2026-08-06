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

import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, isTable, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { executeRows } from '@oxyhq/db';
import {
  findIdColumnViolations,
  findImplicitWholeRowReads,
  findSchemaInvariantViolations,
  findUnsupportedExpiryColumns,
} from '@oxyhq/db/assert';
import { closePostgres, connectPostgres, getDb } from '../postgres';
import * as schema from '../schema';
import * as catalogModule from '../schema/catalog';
import { catalogEntities } from '../schema/catalog';
import * as genresModule from '../schema/genres';
import * as libraryModule from '../schema/library';
import { playbackStates, playlists, userSavedPlaylists } from '../schema/library';
import { DEFERRED_FOREIGN_KEYS, ID_COLUMNS_WITHOUT_FOREIGN_KEY } from '../schema/deferredForeignKeys';
import { PROTECTED_COLUMNS_BY_TABLE } from '../schema/protectedColumns';
import { EXPIRY_SWEEP_TARGETS } from '../expiry';

/**
 * Traversal floor for every gate below. See this file's own doc comment.
 * 19 (Task 2: catalog.ts + genres.ts) + 12 (Task 3: library.ts) = 31.
 */
const MINIMUM_TABLES = 31;

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

beforeAll(async () => {
  // `TEST_DATABASE_URL` is what CI's `postgres:17` service publishes; a local
  // run falls back to whatever `DATABASE_URL` a developer already has pointed
  // at their own `docker-compose.postgres.yml` instance. Neither overwrites
  // an already-set `DATABASE_URL` — a developer who exported one explicitly
  // keeps control of which database the suite touches.
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  await connectPostgres();
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
    // Scoped to catalog.ts + genres.ts, not the barrel-wide `tables()` — see
    // `tablesIn`'s own doc comment for why a per-task exact-match check must
    // never read the cumulative barrel.
    const present = tablesIn(catalogModule, genresModule)
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

    // RELATIONS.md: playlists ARE hard-deleted today
    // (controllers/playlists.controller.ts:383), and the app cleans up
    // PlaylistTrack but never Library.savedPlaylists — a real orphan a
    // DB-level CASCADE fixes without any application change.
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
