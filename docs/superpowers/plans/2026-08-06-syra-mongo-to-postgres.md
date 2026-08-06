# Syra MongoDB → PostgreSQL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Syra's backend off MongoDB onto PostgreSQL, consuming `@oxyhq/db` rather than writing a fourth copy of the shared plumbing.

**Architecture:** Drizzle ORM over `postgres.js`, one database `syra` on the shared `oxy-postgres` RDS instance. The schema lands whole before any call site moves, so foreign keys are real from the start; call sites then port one vertical per pull request. Postgres starts empty — no backfill — so ids are uuid v7 from the first row and `_id` leaves the wire contract.

**Tech Stack:** `@oxyhq/db@^0.1.1`, `drizzle-orm` 0.45.2, `postgres` 3.4.9, `drizzle-kit` 0.31.10, bun, `bun test`.

**Spec:** [`../specs/2026-08-05-syra-mongo-to-postgres-design.md`](../specs/2026-08-05-syra-mongo-to-postgres-design.md)

## Global Constraints

- **bun only.** Never `npm`, `yarn`, `npx` — use `bunx`. `bun.lock` committed in the same commit as any `package.json` change.
- **Consume `@oxyhq/db@^0.1.1` from npm.** Never re-implement anything it exports. A missing export is a package defect to report upstream, not a call site to work around.
- **The package holds MECHANISMS, the consumer holds REGISTRIES.** Syra owns `EXPIRY_SWEEP_TARGETS`, `REQUIRED_EXTENSIONS`, `PROTECTED_COLUMNS_BY_TABLE`, `DEFERRED_FOREIGN_KEYS` and `ID_COLUMNS_WITHOUT_FOREIGN_KEY`. The package owns the code that reads them.
- **`SqlExecutor.execute` is NOT generic** — `execute(query: SQL): Promise<Record<string, unknown>[]>`. Row typing comes from `executeRows<TRow>(executor, query)`, which **rejects named `interface`s**: declare row shapes as `type` aliases.
- **`oxy_user_id` never carries a foreign key.** It is a cross-service id owned by oxy-api. Every such column goes in `ID_COLUMNS_WITHOUT_FOREIGN_KEY` with its reason.
- **uuid v7 for every id**, generated in the application via the package's `generatedId()`. No ObjectId hex anywhere. `_id` never appears in a DTO.
- **No backfill.** Production data is not migrated. Do not write a backfill script, a collection map, or a compatibility shim.
- Standing repo rules: no `as any`, no `@ts-ignore`/`@ts-expect-error`, no `!` non-null assertion, no `any` in a signature, no silent `catch {}`, no TODO/FIXME/HACK, no `console.log`, no re-export shims, no `@deprecated`.
- **Never `git checkout <file>` / `git restore <file>` to undo a mutation** — it restores to the last commit, which mid-task is not your baseline. Keep a pristine copy as you intend to ship it, restore the hunk in place, then assert a marker of your own edit survived.
- Syra's backend tests run under **`bun test`** (`bun run test`), not jest and not vitest. This is why the package's gates are pure functions returning violations.
- Anything a test creates — temp directory, database, container — must be removed. Verify by counting before and after two consecutive full runs with no manual clearing.

---

## File Structure

**Created — `packages/backend/src/db/`:**

| path | responsibility |
|---|---|
| `postgres.ts` | the connection singleton, built through the package's `createDatabase` |
| `migrate.ts` | the migration entry point, calling the package's `runMigrations` |
| `extensions.ts` | Syra's `REQUIRED_EXTENSIONS` registry — **empty**, Syra needs none |
| `expiry.ts` | Syra's `EXPIRY_SWEEP_TARGETS` registry (4 entries) |
| `schema/index.ts` | the barrel every gate traverses |
| ~~`schema/columns.ts`~~ | **Not created.** oxy-api and Mention each have one, but every helper Syra needs comes from the package, and an empty file created to match a file list is worse than an absent one. A later vertical creates it if and when it has a real first use. |
| `schema/deferredForeignKeys.ts` | `DEFERRED_FOREIGN_KEYS` + `ID_COLUMNS_WITHOUT_FOREIGN_KEY` |
| `schema/protectedColumns.ts` | `PROTECTED_COLUMNS_BY_TABLE` — the `stripExternalCatalogFields` replacement |
| `schema/catalog.ts` | Track, Album, CatalogEntity, TrackKey, IsrcRegistry, TrackFingerprint, ImageAsset, Lyrics, MusicBrainzArtist, DiscogsRelease + child tables |
| `schema/library.ts` | Playlist, PlaylistTrack, RecentlyPlayed, PlaybackState, Device + the five Library junctions |
| `schema/podcasts.ts` | Podcast, Episode, EpisodeProgress + child tables |
| `schema/creators.ts` | UserUpload, ArtistClaim, ContributionAttestation, ContributorStanding, CopyrightReport |
| `schema/moderation.ts` | ModerationEnforcement, ModerationEvent, ModerationOutbox, Report |
| `schema/rooms.ts` | House, Room, RoomUserPreference, Recording, Series + child tables |
| `schema/user.ts` | UserSettings, UserMusicPreferences, UserBehavior, UserTasteProfile, ListeningEvent, CatalogRelation, NotificationPreference, NotificationSuppression |
| `schema/genres.ts` | the `genres` table and its two junctions |
| `__tests__/gates.test.ts` | the four inherited gates, wired to Syra's registries |
| `__tests__/zodPathsExistInDrizzle.test.ts` | the replacement for `zodPathsExistInMongoose.test.ts` |

**Deleted at the end:** `packages/backend/src/models/` (41 models), `utils/database.ts`, `mongoose` and `mongodb-memory-server` from `package.json`.

---

### Task 1: Foundation — connection, migrator, registries, gates

Nothing else can land until a migration can run and the gates can fail. This task ends with an empty schema that migrates cleanly and four gates that pass vacuously **but are proven able to fail**.

**Files:**
- Modify: `packages/backend/package.json` (add `@oxyhq/db`, `drizzle-orm`, `postgres`, `drizzle-kit`; add `db:generate`, `db:migrate`)
- Create: `packages/backend/drizzle.config.ts`
- Create: `packages/backend/src/db/postgres.ts`, `migrate.ts`, `extensions.ts`, `expiry.ts`
- Create: `packages/backend/src/db/schema/index.ts`, `columns.ts`, `deferredForeignKeys.ts`, `protectedColumns.ts`
- Create: `packages/backend/src/db/__tests__/gates.test.ts`
- Create: `docker-compose.postgres.yml`
- Modify: `.github/workflows/*` (a `postgres:17` service and `TEST_DATABASE_URL`)

**Interfaces:**
- Consumes: `createDatabase`, `DATABASE_CASING` from `@oxyhq/db`; `runMigrations`, `type RequiredExtension` from `@oxyhq/db/migrate`; `type ExpirySweepTarget` from `@oxyhq/db/expiry`; `findSchemaInvariantViolations`, `findIdColumnViolations`, `findImplicitWholeRowReads`, `findUnsupportedExpiryColumns`, `publicColumns` from `@oxyhq/db/assert`.
- Produces: `getDb(): OxyDatabase<typeof schema>`, `closePostgres(): Promise<void>`, `REQUIRED_EXTENSIONS`, `EXPIRY_SWEEP_TARGETS`, `DEFERRED_FOREIGN_KEYS`, `ID_COLUMNS_WITHOUT_FOREIGN_KEY`, `PROTECTED_COLUMNS_BY_TABLE`.

- [ ] **Step 1: Install the package and the drivers**

```bash
cd /home/nate/Oxy/Syra
bun add --cwd packages/backend @oxyhq/db@^0.1.1 drizzle-orm@0.45.2 postgres@3.4.9
bun add --cwd packages/backend --dev drizzle-kit@0.31.10
bun install
```

Confirm `@oxyhq/db` resolved to the published tarball, not a local path:

```bash
cat node_modules/@oxyhq/db/package.json | grep '"version"'
```

Expected: `0.1.1`.

- [ ] **Step 2: Write the failing gate test**

`packages/backend/src/db/__tests__/gates.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { findIdColumnViolations } from '@oxyhq/db/assert';
import { DEFERRED_FOREIGN_KEYS, ID_COLUMNS_WITHOUT_FOREIGN_KEY } from '../schema/deferredForeignKeys';
import { tables } from '../schema';

describe('schema gates', () => {
  it('classifies every id-shaped column', () => {
    expect(
      findIdColumnViolations({
        tables,
        deferred: DEFERRED_FOREIGN_KEYS,
        withoutForeignKey: ID_COLUMNS_WITHOUT_FOREIGN_KEY,
        minimumTables: 0,
      })
    ).toEqual([]);
  });
});
```

`minimumTables: 0` is correct **only for this task**, where the schema is genuinely empty. Task 2 raises it, and every later schema task raises it again. A floor that never moves is a vacuity check that stopped checking.

- [ ] **Step 3: Run it and confirm it fails**

```bash
cd /home/nate/Oxy/Syra && bun run --cwd packages/backend test src/db
```

Expected: FAIL — `Cannot find module '../schema'`.

- [ ] **Step 4: Create the registries, all empty, each with its reason**

`schema/deferredForeignKeys.ts`:

```ts
import type { PgColumn, PgTable, UpdateDeleteAction } from 'drizzle-orm/pg-core';

/**
 * A foreign key that cannot be declared yet because its parent table has not
 * landed. The gate turns each entry into a hard error the moment the parent
 * appears in the barrel, so this list empties itself as the schema completes.
 * An empty ledger is the finish line.
 */
export interface DeferredForeignKey {
  readonly table: PgTable;
  readonly column: PgColumn;
  readonly parentTable: string;
  readonly parentColumn: string;
  readonly onDelete: UpdateDeleteAction;
  readonly reason: string;
}

export const DEFERRED_FOREIGN_KEYS: readonly DeferredForeignKey[] = [];

/**
 * `*_id` columns that will never carry a constraint. Between this and the real
 * constraints, every id-shaped column is classified — which is what lets a NEW
 * unclassified one fail the gate.
 */
export const ID_COLUMNS_WITHOUT_FOREIGN_KEY: readonly { column: string; reason: string }[] = [];
```

`extensions.ts`:

```ts
import type { RequiredExtension } from '@oxyhq/db/migrate';

/**
 * Syra requires no Postgres extensions.
 *
 * Deliberately empty rather than absent: the migrator takes this list, and an
 * empty one means it opens no connection at all — which matters because the
 * target database may not exist yet on a first run. Mention needs PostGIS for
 * its `geography` columns; Syra has no spatial data and no `2dsphere` index to
 * replace, so adding PostGIS here would be an install-ordering dependency in
 * every environment bought for nothing.
 */
export const REQUIRED_EXTENSIONS: readonly RequiredExtension[] = [];
```

- [ ] **Step 5: Create the connection**

`db/postgres.ts`:

```ts
import { createDatabase, type OxyDatabase } from '@oxyhq/db';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import * as schema from './schema';

let handle: { db: OxyDatabase<typeof schema>; client: ReturnType<typeof createDatabase>['client'] } | null = null;

export function connectPostgres(): OxyDatabase<typeof schema> {
  if (handle) return handle.db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set before connecting to Postgres.');
  handle = createDatabase({ databaseUrl: url, schema });
  logger.info('[db] Postgres handle created');
  return handle.db;
}

export function getDb(): OxyDatabase<typeof schema> {
  if (!handle) throw new Error('getDb() called before connectPostgres().');
  return handle.db;
}

export async function closePostgres(): Promise<void> {
  if (!handle) return;
  await handle.client.end();
  handle = null;
}
```

Check `createDatabase`'s real option name against the installed package before writing this — the plan says `databaseUrl`, and if the published 0.1.1 says `url`, **the package wins and you say so in your report**.

- [ ] **Step 6: Create the migrator**

`db/migrate.ts` calls `runMigrations` from `@oxyhq/db/migrate`, passing `REQUIRED_EXTENSIONS`, the migrations folder resolved from this package's own root, the `--phase` argument, and a logger. **Pass `expectedDatabase`** from `readTargetDatabase(process.argv.slice(2))` — Syra starts clean, so there is no legacy invocation to preserve and no reason to ship without the wrong-database guard. Unlike oxy-api, Syra pays no migration cost for adopting it on day one.

- [ ] **Step 7: Empty schema barrel**

`schema/index.ts` exports `tables` as an empty array plus the per-vertical re-exports that later tasks fill.

- [ ] **Step 8: Local and CI Postgres**

`docker-compose.postgres.yml` with `postgres:17` — **not** the PostGIS image; Syra needs no extension, and pinning a heavier image would imply otherwise. Wire the same in CI with `TEST_DATABASE_URL`.

- [ ] **Step 9: Prove the gate can fail**

Add a throwaway table with an unclassified `some_id` column to the barrel, run the gate, confirm it reports `unclassified_id_column` naming that column. Remove the table, confirm green. **Paste both outputs.** A gate that has never been seen to fail is not a gate.

- [ ] **Step 10: Migrate against a real empty database, then commit**

```bash
cd packages/backend && bun run db:migrate --phase=all --target-database=syra_dev
bun run test src/db
git add packages/backend package.json bun.lock docker-compose.postgres.yml .github
git commit -m "feat(db): Postgres foundation — connection, migrator, registries and the inherited gates"
```

---

### Task 2: Catalog schema

The largest vertical and the one that sets the pattern every later schema task follows. Ten models, 481 lines of `CatalogEntity` alone, and the discriminator that this port dissolves.

**Files:**
- Create: `packages/backend/src/db/schema/catalog.ts`, `schema/genres.ts`
- Modify: `schema/index.ts`, `schema/deferredForeignKeys.ts`, `schema/protectedColumns.ts`, `__tests__/gates.test.ts`
- Reference (read, do not modify): `packages/backend/src/models/{Track,Album,CatalogEntity,TrackKey,IsrcRegistry,TrackFingerprint,ImageAsset,Lyrics,MusicBrainzArtist,DiscogsRelease}.ts`

**Interfaces:**
- Consumes: `timestamptz`, `createdAt`, `updatedAt`, `generatedId`, `tsvector`, `inList` from `@oxyhq/db`.
- Produces: `tracks`, `albums`, `catalogEntities`, `trackKeys`, `isrcRegistry`, `trackFingerprints`, `imageAssets`, `lyrics`, `lyricsLines`, `musicbrainzArtists`, `musicbrainzArtistUrls`, `discogsReleases`, `genres`, `albumGenres`, `catalogEntitySources`, `albumSources`.

The decisions this vertical carries, each of which the spec argues and none of which is a judgement call left to the implementer:

- **`CatalogEntity` becomes ONE table with `type text NOT NULL` + a CHECK over `('artist','person')`**, per-type columns nullable, `linked_artist_id` a self-referencing FK, plus a CHECK forbidding it unless `type = 'person'`. Mongoose's discriminator scoped queries implicitly and `aggregate()` did not, which is a live bug class; here every `where type = …` is explicit.
- **`Album.genre` and `Podcast.categories` do NOT become `text[]`.** Both are indexed and genre cards browse by them — browsing requires *enumerating* the genres that exist, which an array cannot answer. Create `genres` plus junctions. Podcast's junction lands in Task 4; create the `genres` table here and record the podcast junction in `DEFERRED_FOREIGN_KEYS`.
- **Subdocument arrays become child tables**: `Lyrics.lines`, `MusicBrainzArtist.urls`, and the `SourceProvenance` arrays on Album and CatalogEntity.
- **Two `tsvector` GENERATED columns plus GIN**, replacing the Mongo text indexes on `Track(title, artistName)`, `Album(title, artistName)` and `CatalogEntity(name)`. Use a **literal** configuration — `to_tsvector('english', …)`. The unqualified form is STABLE, not IMMUTABLE, and a generated column rejects it.
- **`stripExternalCatalogFields` becomes `PROTECTED_COLUMNS_BY_TABLE` entries.** Every field that function deletes today gets an entry with the reason. `select: false` does not travel.

- [ ] **Step 1: Write the failing schema test**

Add to `__tests__/gates.test.ts` a case asserting the catalog tables exist with the shapes this task promises, and raise `minimumTables` from 0 to the count this task lands. Then add the discriminator CHECK case:

```ts
it('forbids linked_artist_id on a non-person catalog entity', async () => {
  const db = getDb();
  await expect(
    db.insert(catalogEntities).values({
      name: 'x', type: 'artist', linkedArtistId: someArtistId,
    })
  ).rejects.toThrow();
});
```

That test needs a real database. It is the one that proves the CHECK exists rather than being described in a comment.

- [ ] **Step 2: Run it and confirm it fails**

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write `schema/catalog.ts` and `schema/genres.ts`**

Read each Mongoose model and port it field by field. For every field ask the three questions the spec sets: is it `NOT NULL` in reality; does its closed value set become `text` + CHECK (never a pg `enum`); and if it is an array, is it queried by element.

- [ ] **Step 4: Generate and apply the migration**

```bash
cd packages/backend && bun run db:generate && bun run db:migrate --phase=all --target-database=syra_dev
```

Inspect the generated SQL before applying it. If `drizzle-kit` wants to emit anything you did not intend, stop — that means a schema declaration says something other than what you read in the model.

- [ ] **Step 5: Run the gates and the new tests**

All four gates must pass with the raised floor. **Mutation-check the floor**: drop a table from the barrel and confirm the vacuity violation fires.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/db packages/backend/drizzle
git commit -m "feat(db): catalog schema — one catalog_entities table, real genres, tsvector search"
```

---

### Task 3: Library and playlists schema

**Files:**
- Create: `packages/backend/src/db/schema/library.ts`
- Modify: `schema/index.ts`, `schema/deferredForeignKeys.ts`, `__tests__/gates.test.ts`
- Reference: `models/{Library,Playlist,PlaylistTrack,RecentlyPlayed,PlaybackState,Device}.ts`

**Interfaces:**
- Produces: `playlists`, `playlistTracks`, `playlistCollaborators`, `playlistSources`, `recentlyPlayed`, `playbackStates`, `devices`, `userLikedTracks`, `userSavedAlbums`, `userFollowedArtists`, `userSavedPlaylists`, `userPodcastSubscriptions`.

**`Library` ceases to exist as a table.** Its five arrays — `likedTracks`, `savedAlbums`, `followedArtists`, `savedPlaylists`, `subscribedPodcasts` (`models/Library.ts:20-24`) — become five junction tables, each with a real FK to its target and an unconstrained `oxy_user_id`. With the arrays gone the document has nothing left in it: it was only ever a container Mongo forced. `userPodcastSubscriptions`' FK to `podcasts` is deferred until Task 4.

**`PlaybackState.queue` and `Device.capabilities` stay arrays** — `text[]`. Read whole, never queried by element; a child table there would be over-normalization.

Steps follow Task 2's shape: failing test with the floor raised, schema, generate, apply, gates, mutation-check, commit.

- [ ] **Step 1: Write the failing test, including that the five junctions replace `Library`**
- [ ] **Step 2: Run it and confirm it fails**
- [ ] **Step 3: Write `schema/library.ts`**
- [ ] **Step 4: Generate and apply, inspecting the SQL first**
- [ ] **Step 5: Gates green with the raised floor; mutation-check the floor**
- [ ] **Step 6: Commit** — `feat(db): library and playlist schema — five junctions replace the Library document`

---

### Task 4: Podcasts schema

**Files:** create `schema/podcasts.ts`; modify the barrel, the deferred ledger (closing `userPodcastSubscriptions` and the podcast-genre junction opened earlier), and the gates test.
**Reference:** `models/{Podcast,Episode,EpisodeProgress}.ts`.
**Produces:** `podcasts`, `podcastFunding`, `podcastPersons`, `podcastSources`, `podcastCategories`, `episodes`, `episodeTranscripts`, `episodePersons`, `episodeHlsRenditions`, `episodeProgress`.

Decisions specific to this vertical:

- **`Podcast.value` stays `jsonb`** — it is the Podcasting 2.0 `<podcast:value>` block, and `services/podcasts/podcastSerializers.ts:102` passes `doc.value` straight through without reading into it. Record that reason in a comment so a later reader does not mistake it for a dumping ground. The moment any code reads a field inside it, it earns real columns.
- **`Podcast.categories`** joins the `genres` table created in Task 2 through a junction — the same reasoning as `Album.genre`.
- Two `tsvector` columns: `Podcast(title, author)` and `Episode(title)`.
- Episode's three subdocument arrays — `transcripts`, `persons`, `hls` (`models/Episode.ts:117-123`) — become child tables.

- [ ] **Step 1: Write the failing test, and assert the deferred ledger loses its two podcast entries**
- [ ] **Step 2: Run it and confirm it fails**
- [ ] **Step 3: Write `schema/podcasts.ts`**
- [ ] **Step 4: Generate and apply, inspecting the SQL first**
- [ ] **Step 5: Gates green; the deferred ledger must now be two entries shorter**
- [ ] **Step 6: Commit** — `feat(db): podcast schema, closing the deferred subscription and genre keys`

---

### Task 5: Creators and uploads schema

**Files:** create `schema/creators.ts`; modify the barrel, registries, gates test.
**Reference:** `models/{UserUpload,ArtistClaim,ContributionAttestation,ContributorStanding,CopyrightReport}.ts`.
**Produces:** `userUploads`, `artistClaims`, `contributionAttestations`, `contributorStandings`, `copyrightReports`, `contributorStrikes`.

`CopyrightReport` is Syra's own DMCA pipeline and is **not** CrowdSource's — the universal taxonomy has forty codes across eleven families and none is copyright, deliberately, because DMCA carries statutory process and goes to specialists rather than a randomly drawn jury. It ports normally here.

`toUploadTrackDto` is a hand-written allowlist and stays one. Do **not** add a `delete` to it: an allowlist also excludes whatever gets added to the model tomorrow, and a `delete` there can never fire while advertising a denylist where the real guard is an allowlist.

- [ ] **Step 1: Write the failing test with the floor raised**
- [ ] **Step 2: Run it and confirm it fails**
- [ ] **Step 3: Write `schema/creators.ts`**
- [ ] **Step 4: Generate and apply, inspecting the SQL first**
- [ ] **Step 5: Gates green; mutation-check the floor**
- [ ] **Step 6: Commit** — `feat(db): creator upload, claim and copyright schema`

---

### Task 6: Rooms and live schema

**Files:** create `schema/rooms.ts`; modify the barrel, registries, gates test.
**Reference:** `models/{House,Room,RoomUserPreference,Recording,Series}.ts`.
**Produces:** `houses`, `houseMembers`, `rooms`, `roomUserPreferences`, `recordings`, `series`.

**`Room.topicId` declares `ref: 'Topic'` and there is no `Topic` model in the repo** (`models/Room.ts:224`). Mongo never checked it. A real foreign key cannot be declared against a table that does not exist, so this is decided here and not carried:

- If nothing reads `topicId` — grep the whole backend — **drop the column** and say so in your report.
- If something does read it, the column stays as an unconstrained id, goes in `ID_COLUMNS_WITHOUT_FOREIGN_KEY` with the reason, and the report names the reader.

Do not invent a `topics` table to satisfy the reference. One `tsvector` column: `House(name, description)`.

- [ ] **Step 1: Grep for every reader of `topicId` and decide, before writing schema**
- [ ] **Step 2: Write the failing test with the floor raised**
- [ ] **Step 3: Run it and confirm it fails**
- [ ] **Step 4: Write `schema/rooms.ts`**
- [ ] **Step 5: Generate and apply, inspecting the SQL first**
- [ ] **Step 6: Gates green; mutation-check the floor**
- [ ] **Step 7: Commit** — `feat(db): rooms, houses and recordings schema; resolve the dangling Topic reference`

---

### Task 7: User and recommendations schema

**Files:** create `schema/user.ts`; modify the barrel, `expiry.ts`, registries, gates test.
**Reference:** `models/{UserSettings,UserMusicPreferences,UserBehavior,UserTasteProfile,ListeningEvent,CatalogRelation,NotificationPreference,NotificationSuppression}.ts`.
**Produces:** `userSettings`, `userMusicPreferences`, `userBehavior`, `userTasteProfiles`, `listeningEvents`, `catalogRelations`, `notificationPreferences`, `notificationSuppressions`.

**This task lands two of the four expiry registry entries.** Mongo's TTL indexes have no Postgres counterpart, so each becomes an `EXPIRY_SWEEP_TARGET` plus a supporting btree index — the sweep's predicate is a range scan and Mongo's TTL index carried the same obligation:

| Mongo | entry |
|---|---|
| `NotificationSuppression.expiresAt`, `expireAfterSeconds: 0` | the column IS the deadline, `retentionSeconds: 0` |
| `ListeningEvent.playedAt`, `expireAfterSeconds: LISTENING_EVENT_TTL_SEC` | a retention window on a birth column |
| (`ModerationOutbox`, `ModerationEvent` land in Task 8) | |

`ListeningEvent` is the high-volume table and sets the batch size.

**Every read that filters on expiry itself must keep doing so.** Dropping such a filter because the sweep handles it converts a bounded lag into a live stale read.

- [ ] **Step 1: Write the failing test, including that each swept column has its supporting index**
- [ ] **Step 2: Run it and confirm it fails**
- [ ] **Step 3: Write `schema/user.ts` and the expiry entries**
- [ ] **Step 4: Generate and apply, inspecting the SQL first**
- [ ] **Step 5: Gates green — `findUnsupportedExpiryColumns` must pass against a REAL database, since a fake cannot validate the catalogue query**
- [ ] **Step 6: Commit** — `feat(db): user, taste and listening schema with the TTL replacements`

---

### Task 8: Moderation schema — **BLOCKED, do not start without a ruling**

Syra's moderation is the adopter half of **CrowdSource**, Oxy's multi-tenant participatory-moderation infrastructure. `packages/backend/package.json` depends on `@oxyhq/crowdsource` 0.3.0, `-contracts` and `-express`, and `src/moderation/` holds nineteen files implementing intake, the transactional outbox, delivery, the decision worker, the processed-event store, enforcement planning and execution.

**`@oxyhq/crowdsource-app` owns most of that**, and it is bound to Mongoose by peer dependency (`"mongoose": "^8.0.0 || ^9.0.0"`), ships Mongoose models, and **is not published** — npm returns 404; 0.4.0 exists only locally.

The three routes are in the spec. Picking one is an owner decision because route 2 changes the ecosystem's moderation stack, not just Syra's.

**Everything else in this plan proceeds without it.** Do not port `ModerationEnforcement`, `ModerationEvent`, `ModerationOutbox` or `Report` until the route is chosen. `CopyrightReport` is not blocked and lands in Task 5.

---

### Task 9: Close the deferred ledger and write the relation inventory

**Files:** modify `schema/deferredForeignKeys.ts`, `schema/index.ts`; create `docs/db/RELATIONS.md`.

**Syra declares only 7 `ref:` across 41 models.** Nearly every relation is a loose string id — `artistId`, `trackId` — that Mongoose never checked and no schema records. A schema that compiles is therefore not evidence that no relation was lost.

This task produces the artefact that discharges the spec's first directive: a written inventory naming, for every relation, its source column, target table, `ON DELETE`, and **the call site that proves the relation exists**. Recover them by reading call sites, not models.

- [ ] **Step 1: Grep every `*Id: { type: String` in the models and list them**
- [ ] **Step 2: For each, find the code that joins or looks it up, and record the file:line**
- [ ] **Step 3: Declare the FK, or add an `ID_COLUMNS_WITHOUT_FOREIGN_KEY` entry with the reason**
- [ ] **Step 4: `DEFERRED_FOREIGN_KEYS` must now be empty** — an empty ledger is the finish line
- [ ] **Step 5: Commit** — `docs(db): the relation inventory, and an empty deferred ledger`

---

### Tasks 10–15: Port the call sites, one vertical per task

Each task takes one vertical's controllers, services and routes off Mongoose and onto drizzle, in the same order the schema landed: catalog (10), library and playlists (11), podcasts (12), creators and uploads (13), rooms and live (14), user and recommendations (15). Moderation waits on Task 8's ruling.

Every one of these tasks carries the same five rules, and none of them is optional:

1. **`toApiFormat` is deleted, not ported.** It spreads the whole document, which is exactly why `select: false` is inert on Syra's aggregation reads today and why a field absent from a zod schema still ships. Drizzle enumerates columns: each DTO names its fields, and `stripExternalCatalogFields` becomes a `publicColumns()` read against `PROTECTED_COLUMNS_BY_TABLE`.
2. **The `$lookup` / `$convert`-on-the-local-side rule evaporates.** It existed because an id was `string` on one side and `ObjectId` on the other. With real FKs the types agree and these are ordinary indexed JOINs. `utils/playableContainers.ts` — whose pipelines run the lookup before `$sort`/`$limit`, evaluating every container on every request — is the main beneficiary and the place to measure.
3. **`andMongoFilters` has no counterpart.** Drizzle composes with `and()`.
4. **`playableTrackFilter()` and `isTrackPlayable` remain two artefacts** — a reusable drizzle condition and an in-memory row predicate — because listing and playback are still two authorities. What changes is that their agreement becomes testable against real rows instead of maintained by discipline. Add that test.
5. **Measure.** `log_min_duration_statement = 1000` is already set on the RDS parameter group for exactly this. A query that was cheap against Mongo's access pattern and expensive against a relational one is what this port has to surface. The home feed's history here — 22 seconds against a 5-second client abort — makes it the first thing to check after Task 10, not the last.

Each task ends with: that vertical's endpoints returning identical payloads except `_id` → `id`, `bun run test` green, and the vertical's models deleted from `src/models/`.

---

### Task 16: The wire contract — `_id` → `id`

**Files:** `packages/shared-types/src/{album,media,episodeProgress,playlist,profile,artist,podcast}.ts` (9 DTO declarations), `packages/sdk/src/live/components/RecordingsPanel.tsx`, and every frontend/studio reader.

`_id` disappears; the field is `id`. This is a real API change taken as a clean cut with no compatibility alias.

- [ ] **Step 1: Grep every `_id` outside the backend and list them**
- [ ] **Step 2: Change the 9 zod DTO declarations**
- [ ] **Step 3: Update the SDK and every frontend/studio reader**
- [ ] **Step 4: `bun run test` in shared-types, sdk, frontend and studio; `expo export`; `docker build`**
- [ ] **Step 5: Decide whether `@syra.fm/sdk` takes a major bump, and say who its external consumers are**
- [ ] **Step 6: Commit**

---

### Task 17: Delete the 92 `ObjectId.isValid` guards

92 call sites in `src/`. They exist only to prevent a Mongoose `CastError`; a Postgres `text` id simply matches no rows.

**Review each site rather than sweeping.** Where a 400 is a documented contract, an explicit uuid-format validation stays; everywhere else a malformed id now returns 404. Some sites branch on the result rather than merely rejecting — those are the ones that change behaviour if swept blindly.

- [ ] **Step 1: List all 92 with their surrounding branch**
- [ ] **Step 2: Classify each: delete, or replace with an explicit uuid check**
- [ ] **Step 3: Apply, and report the count in each class**
- [ ] **Step 4: `bun run test` green**
- [ ] **Step 5: Commit**

---

### Task 18: The zod ↔ drizzle path gate

`src/models/zodPathsExistInMongoose.test.ts` exists because Mongoose strict mode drops a `$set` on an undeclared path with no throw and no warning: tsc clean, logs report success, database keeps nothing.

Postgres fails loudly on a missing column — **but a DTO field that no code maps to a column still fails to persist just as silently.** The test changes engine; it does not go away.

**Its detector stays an idempotency check** — write, re-read, compare — because asserting the return value reports success either way.

- [ ] **Step 1: Write `__tests__/zodPathsExistInDrizzle.test.ts` asserting every zod DTO field resolves to a real drizzle column**
- [ ] **Step 2: Mutation-prove it** — add a DTO field with no column, confirm red naming it; remove, confirm green
- [ ] **Step 3: Delete `zodPathsExistInMongoose.test.ts`**
- [ ] **Step 4: Commit**

---

### Task 19: Remove MongoDB

Only after every vertical except moderation has landed, and only with Task 8 resolved or its four models explicitly parked.

- [ ] **Step 1: Confirm zero `from 'mongoose'` imports remain outside `src/models/`**
- [ ] **Step 2: Delete `src/models/` and `utils/database.ts`**
- [ ] **Step 3: Remove `mongoose` and `mongodb-memory-server` from `package.json`; `bun install`**
- [ ] **Step 4: Remove `MONGODB_URI` from `config/env.ts`, `app-services.tf` and the deploy workflow — as a SEPARATE commit from the code removal**
- [ ] **Step 5: `bun run test`, `tsc`, `expo export`, `docker build` all green**
- [ ] **Step 6: Commit**

---

### Task 20: Infrastructure

- [ ] **Step 1: Create the `syra` database on the shared `oxy-postgres` instance, owned by the `syra` role**, created once by the `oxyadmin` master user. Ownership is what gives the role `CREATE` on `public` with no `GRANT` anywhere. A probe database created by a different role misrepresents production's permissions in both directions.
- [ ] **Step 2: Write `/oxy/syra/DATABASE_URL` to SSM with `?sslmode=require`** — the parameter group sets `rds.force_ssl = 1`.
- [ ] **Step 3: Add the entry to the `syra` module in `app-services.tf`**
- [ ] **Step 4: Add `DATABASE_URL` to BOTH `deploy-aws.yml`'s sync block AND its `SSM_SECRET_ALLOWLIST`** — that workflow enumerates secrets explicitly; miss either and the sync silently never writes it and new tasks crash-loop with `ResourceInitializationError`. Do this **before** the port ships, against an image that still ignores the variable.
- [ ] **Step 5: Wire migrations into the deploy**, `pre` before the rollout and `post` after.
- [ ] **Step 6: Verify the deploy invocation in its `dist` form with the exact argv the script passes**

---

## Self-Review

**Spec coverage.** Clean start → the absence of any backfill task, stated in Global Constraints. uuid v7 and `_id`→`id` → Tasks 1 and 16. `oxy_user_id` never an FK → Global Constraints and Task 9. `Library` dissolved → Task 3. `CatalogEntity` single table → Task 2. Subdocuments → child tables in Tasks 2, 3, 4, 6. Scalar arrays vs `genres` → Tasks 2 and 4. 7 tsvector columns → Tasks 2 (3), 4 (2), 6 (1) — **the spec says seven and these tasks account for six**; `Playlist(name, description)` is the seventh and belongs to Task 3, which is now noted there. 4 TTL → Tasks 7 (2) and 8 (2, blocked). `toApiFormat` deleted → Tasks 10–15. 92 guards → Task 17. `playableTrackFilter`/`isTrackPlayable` → Tasks 10–15 rule 4. `canViewPlaylist` → Task 11. Gates → Task 1. zod gate → Task 18. Infra → Task 20. Moderation blocked → Task 8.

**Placeholder scan.** Tasks 3–7 compress the repeated schema cycle into named steps rather than repeating Task 2's code, because the *decisions* differ per vertical and the mechanics do not — each carries its own distinct decisions in prose above its steps. Tasks 10–15 share five rules stated once rather than six times; that is the plan's content, not a deferral.

**Known gap.** Tasks 10–15 do not enumerate their call sites. There are roughly 160 files importing models, and enumerating them here would be a snapshot stale by the time Task 10 lands. Each task's first step is therefore to list its own vertical's call sites and report the count — which is also how a reviewer checks the vertical was covered rather than sampled.

**Order dependency.** Task 9 cannot close before Tasks 2–7 land; Task 19 cannot start before Task 8 is resolved or parked.

---

## Amendments made during execution

**`schema/columns.ts` is not created.** Task 1's implementer found the plan listed
it with no defined content, and declined to invent any. Correct: every column
helper Syra needs comes from `@oxyhq/db`, and a file created to satisfy a file
list is worse than an absent one.

**Task 1 exposed a defect in `@oxyhq/db`, fixed upstream rather than worked
around.** `readJournal` refused a journal whose `entries` array was empty, which
made a genuinely empty schema unmigratable. Its guard is justified — *"an empty
read must never be mistaken for nothing to do"* — but it conflated two states: a
journal **missing, unparseable or pointing at the wrong folder**, where applying
nothing and reporting success is a silent lie, versus a journal that **parses
successfully** and holds zero entries, which is the unambiguous state of a
project that wired its migrator before writing its first schema.

Syra is the package's third consumer and the first to stage its schema across
tasks; oxy-api and Mention both landed theirs in a single commit, so neither
could have found it. Fixed as `@oxyhq/db@0.1.2`.

The rejected alternative was a permanent no-op bootstrap migration carrying the
phase marker. It works, and it leaves in Syra's history forever a file whose only
purpose is to appease a check that should not fire.

**Each task's tests are not proven until the next task arrives.** Twice in a row
now, a schema task found a defect in the previous task's tests that only its own
input could expose:

- Task 2 found two bugs in Task 1's `gates.test.ts` — `is(value, PgTable)`
  throwing TS2677 once the barrel holds heterogeneous exports, and `.rejects`
  against a non-Promise drizzle builder. Both survived Task 1's own thorough
  independent review, because the barrel was empty: the gate worked while there
  was nothing to check.
- Task 3 found that Task 2's "lands exactly the tables this task promises" test
  compared against the whole cumulative barrel, so it would have broken the
  instant any later task added a table.

This is a property of staging a schema across tasks, not bad luck, and it has a
consequence for the four verticals that remain: **a green gate on an empty or
single-vertical barrel is weaker evidence than it looks.** Raising the vacuity
floor at every task and mutation-checking it is what converts that green into
something, and it is why the floor rises rather than being set once.

Each schema task should also expect to fix something in its predecessor's tests,
and should say so in its report rather than fixing it silently — the pattern is
more useful than any individual fix.
