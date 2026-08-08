import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import { isTable } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as dtos from '@syra/shared-types';
import * as schema from '../schema';

/**
 * Every field a stored zod DTO declares resolves to real storage.
 *
 * Replaces `models/zodPathsExistInMongoose.test.ts`, which guarded the same
 * class against Mongoose. **The two are not translations of each other** — half
 * the original job is now done by the compiler, and the half that is left is the
 * half that was always invisible.
 *
 * ## What carried over, and what did not
 *
 * NOT carried over: the original's whole rationale. Mongoose strict mode
 * DISCARDS a `$set` on an undeclared path — no throw, no warning — while the
 * zod-derived TypeScript type made the write typecheck. Drizzle has no such
 * failure: an unknown key in `.values({...})` or `.set({...})` is a compile
 * error. Task 10b found `catalog_entities.members` exactly that way. That
 * direction needs no runtime gate any more.
 *
 * CARRIED OVER: the other direction, which `tsc` still cannot see. Nothing
 * forces a DTO to be written through a table, so a zod field can exist in the
 * contract, be returned to clients, be asserted by a passing test, and have no
 * storage anywhere. That was `members` before it was caught, and it had a live
 * reader. Only a runtime comparison against the schema can see it.
 *
 * Also carried over, because they were right: an allowlist so an absence is a
 * visible decision rather than a hole, and a vacuity floor, because every
 * assertion here is "nothing missing" and a broken traversal reports exactly
 * that.
 *
 * ## The trap the original recorded, in its drizzle costume
 *
 * The original notes that `schema.path('links.wikidata')` does not resolve for a
 * single-nested subdocument, so a walk that misses it reports every nested field
 * as missing. The port turned those subdocuments into COLUMN PREFIXES —
 * `links.wikidata` is `linksWikidata`, `stats.followers` is `statsFollowers` —
 * so the drizzle version of that trap is a naive one-to-one name match calling a
 * correct schema broken.
 *
 * {@link resolvePath} handles it structurally rather than by listing names, and
 * the ordering matters: **descend only into what does not already resolve.**
 * That one rule covers three different shapes at once —
 *
 *  - flattened subdocuments (`links.wikidata` → `linksWikidata`);
 *  - a subdocument stored whole as `jsonb` (`user_uploads.lyrics`), where the
 *    leaf fields are inside the value and not columns of their own;
 *  - a subdocument replaced by a FOREIGN KEY (`imageSizes.small` →
 *    `imageSizesSmallId` → `image_assets`), where `imageSizes.small.width` is a
 *    column of the REFERENCED table. Descending past the key would demand 18
 *    columns per DTO that correctly do not exist on it.
 *
 * ## WHAT A GREEN RUN HERE DOES NOT PROVE
 *
 * This check can only reach a vertical whose wire shape is a zod schema. The
 * **rooms vertical is not one** — `rooms`, `houses`, `series`, `recordings`,
 * `room_media_queue_items`, `room_user_preferences` and `playback_states` have
 * no zod DTO at all; `db/rooms/serialize.ts` builds those responses in plain
 * TypeScript. A field added there with no storage is invisible to this gate AND
 * to `tsc`, which is exactly the exposure `catalog_entities.members` had.
 *
 * So: green here says nothing whatsoever about rooms, houses, series or
 * recordings. Closing that needs a contract change (zod DTOs for the vertical),
 * not a wider traversal — and it is stated here rather than only in a report
 * because this is where someone reading a passing run will be.
 *
 * ## A bug in the original, found while porting it
 *
 * Its comment says "Only descend into plain objects. An array of objects is
 * stored as one array path". Its `unwrap` calls `.unwrap()` on anything that has
 * the method, and in **zod 4 `ZodArray.unwrap()` returns the ELEMENT type** — so
 * it walks into array items, against its own stated intent, emitting
 * `members.name` and `sources.provider`. It passes only because Mongoose happens
 * to resolve those through a DocumentArray's `.schema`. {@link unwrapOptional}
 * unwraps optionality and nothing else, so an array is one path here.
 */

// ── The two registries, kept separate on purpose ────────────────────────────

/**
 * Table → the zod DTO that is its wire representation.
 *
 * Hand-maintained because there is no naming rule to derive it from:
 * `artistSchema` is `catalog_entities` rows of `type: 'artist'`, and no
 * mechanical mapping produces that.
 *
 * Hand-maintained pairing risks silent UNDER-coverage — a stored DTO nobody
 * pairs is simply never checked — so the discovery in this file is keyed on
 * TABLES, which the barrel does enumerate: every table must appear here or in
 * {@link TABLES_WITHOUT_DTO}, and a new one fails until someone says which.
 */
const DTO_FOR_TABLE: Record<string, keyof typeof dtos> = {
  catalogEntities: 'artistSchema',
  tracks: 'trackSchema',
  albums: 'albumSchema',
  playlists: 'playlistSchema',
  podcasts: 'podcastSchema',
  episodes: 'episodeSchema',
  episodeProgress: 'episodeProgressSchema',
  userUploads: 'userUploadSchema',
  artistClaims: 'artistClaimSchema',
  contributionAttestations: 'contributionAttestationSchema',
  devices: 'deviceSchema',
  lyrics: 'lyricsSchema',
};

/**
 * Tables with no zod DTO, each with the reason.
 *
 * Not an exemption list to be topped up — it is half the coverage question, and
 * an entry that is wrong is a table nobody is checking. Most are child tables
 * whose parent DTO nests them (`track_sources` is `trackSchema.sources`), join
 * tables carrying no DTO fields of their own, or server-internal tables no
 * client ever sees.
 */
const TABLES_WITHOUT_DTO: Record<string, string> = {
  // Child tables — the parent DTO nests these as arrays; see CHILD_TABLE below.
  albumGenres: 'child of albums — albumSchema.genre',
  albumSources: 'child of albums — albumSchema.sources',
  catalogEntitySources: 'child of catalog_entities — artistSchema.sources',
  catalogEntityStrikes: 'child of catalog_entities — artistSchema.strikes',
  contributionAttestationProvenanceMarkers: 'child — contributionAttestationSchema.provenanceReport.markers',
  contributorStrikes: 'child of contributor_standings',
  episodeHlsRenditions: 'child of episodes — episodeSchema.hls',
  episodePersons: 'child of episodes — episodeSchema.persons',
  episodeTranscripts: 'child of episodes — episodeSchema.transcripts',
  lyricsLines: 'child of lyrics — lyricsSchema.lines',
  playlistCollaborators: 'child of playlists — playlistSchema.collaborators',
  playlistSources: 'child of playlists — playlistSchema.sources',
  podcastCategories: 'child of podcasts — podcastSchema.categories',
  podcastFunding: 'child of podcasts — podcastSchema.funding',
  podcastPersons: 'child of podcasts — podcastSchema.persons',
  podcastSources: 'child of podcasts — podcastSchema.sources',
  trackCredits: 'child of tracks — trackSchema.credits',
  trackHlsRenditions: 'child of tracks — trackSchema.hls',
  trackSources: 'child of tracks — trackSchema.sources',
  userUploadHlsRenditions: 'child of user_uploads — userUploadSchema.hls',
  userUploadProvenanceMarkers: 'child of user_uploads — userUploadSchema.provenance.markers',

  // Join tables — (user, thing) pairs; the DTO side is a list of ids, not fields.
  playlistTracks: 'join table — playlist membership',
  seriesEpisodes: 'join table — series membership',
  houseMembers: 'join table — house membership',
  userFollowedArtists: 'join table — library',
  userLikedTracks: 'join table — library',
  userPodcastSubscriptions: 'join table — library',
  userSavedAlbums: 'join table — library',
  userSavedPlaylists: 'join table — library',
  userTasteArtists: 'join table — taste profile',
  userTasteGenres: 'join table — taste profile',

  // Server-internal — no wire representation at all.
  catalogRelations: 'server-internal — catalogue graph edges',
  copyrightReports: 'server-internal — moderation intake',
  contributorStandings: 'server-internal — repeat-infringer policy',
  discogsReleases: 'server-internal — enrichment mirror',
  genres: 'server-internal — genre vocabulary',
  imageAssets: 'server-internal — addressed by id through /api/images',
  isrcRegistry: 'server-internal — ISRC allocation',
  listeningEvents: 'server-internal — play telemetry',
  musicbrainzArtists: 'server-internal — enrichment mirror',
  musicbrainzArtistUrls: 'server-internal — enrichment mirror',
  notificationPreferences: 'server-internal — hand-built shape, no zod DTO',
  notificationSuppressions: 'server-internal — delivery bookkeeping',
  recentlyPlayed: 'server-internal — derived history',
  trackFingerprints: 'server-internal — acoustic index',
  trackKeys: 'server-internal — AES keys, never serialised',
  userBehavior: 'server-internal — recommendation signal',
  userMusicPreferences: 'no zod DTO — db/user/musicPreferences.ts names columns by hand',
  userSettings: 'no zod DTO — db/user/settings.ts names columns by hand',
  userTasteProfiles: 'server-internal — recommendation state',

  // Rooms vertical — DTOs are hand-built TypeScript in db/rooms/serialize.ts,
  // not zod, so this whole vertical is outside a zod↔drizzle check.
  rooms: 'rooms vertical — hand-built DTO in db/rooms/serialize.ts',
  houses: 'rooms vertical — hand-built DTO in db/rooms/serialize.ts',
  series: 'rooms vertical — hand-built DTO in db/rooms/serialize.ts',
  recordings: 'rooms vertical — hand-built DTO in db/rooms/serialize.ts',
  roomMediaQueueItems: 'rooms vertical — hand-built DTO in db/rooms/serialize.ts',
  roomUserPreferences: 'rooms vertical — hand-built DTO in db/rooms/serialize.ts',
  playbackStates: 'rooms/connect vertical — hand-built DTO',
};

/**
 * A DTO path stored in a CHILD TABLE rather than on the parent's row.
 *
 * Stored, not derived — which is why it is a separate registry. Collapsing the
 * two would let a renamed or re-homed column hide as "computed", and that is the
 * `members` shape exactly: a field that looks accounted for and has no storage.
 * Each value names the table that actually holds it, and the table must exist.
 */
const CHILD_TABLE: Record<string, string> = {
  'artistSchema.sources': 'catalogEntitySources',
  'artistSchema.strikes': 'catalogEntityStrikes',
  'trackSchema.sources': 'trackSources',
  'trackSchema.credits': 'trackCredits',
  'trackSchema.hls': 'trackHlsRenditions',
  'albumSchema.sources': 'albumSources',
  'albumSchema.genre': 'albumGenres',
  'playlistSchema.sources': 'playlistSources',
  'playlistSchema.collaborators': 'playlistCollaborators',
  'podcastSchema.sources': 'podcastSources',
  'podcastSchema.categories': 'podcastCategories',
  'podcastSchema.funding': 'podcastFunding',
  'podcastSchema.persons': 'podcastPersons',
  'episodeSchema.persons': 'episodePersons',
  'episodeSchema.transcripts': 'episodeTranscripts',
  'episodeSchema.hls': 'episodeHlsRenditions',
  'userUploadSchema.hls': 'userUploadHlsRenditions',
  'userUploadSchema.provenance.markers': 'userUploadProvenanceMarkers',
  'contributionAttestationSchema.provenanceReport.markers': 'contributionAttestationProvenanceMarkers',
  'lyricsSchema.lines': 'lyricsLines',
};

/**
 * A DTO path stored on the parent row under a DIFFERENT column name.
 *
 * Renames, not derivations. Two shapes, both real:
 *  - a group prefix renamed wholesale (`externalIds.*` → `external*`), which the
 *    port did to keep `external_ids_musicbrainz_artist_id` under Postgres's
 *    63-byte identifier limit;
 *  - a leaf renamed (`cache.s3Key` → `cacheObjectKey`), which avoids drizzle's
 *    snake_case conversion mangling a digit-adjacent capital: `cacheS3Key`
 *    becomes `cache_s_3_key`.
 */
const RENAMED_COLUMN: Record<string, string> = {
  'artistSchema.externalIds.isrc': 'externalIsrc',
  'artistSchema.externalIds.musicbrainzArtistId': 'externalMusicbrainzArtistId',
  'artistSchema.externalIds.isni': 'externalIsni',
  'artistSchema.externalIds.ipi': 'externalIpi',
  'artistSchema.externalIds.wikidataId': 'externalWikidataId',
  'artistSchema.externalIds.discogsArtistId': 'externalDiscogsArtistId',
  'trackSchema.externalIds.isrc': 'externalIsrc',
  'albumSchema.externalIds.isrc': 'externalIsrc',
  'albumSchema.externalIds.musicbrainzReleaseId': 'externalMusicbrainzReleaseId',
  'playlistSchema.externalIds.isrc': 'externalIsrc',
  'episodeSchema.cache.s3Key': 'cacheObjectKey',
};

/**
 * A DTO path with NO storage, computed on read.
 *
 * This is the registry that must stay small, and it is: **one entry.** Across
 * twelve DTOs and ~400 leaf paths, exactly one field is computed rather than
 * stored. Anything joining it should be scrutinised — a field with no storage
 * and no computation is the `members` defect.
 */
const DERIVED: Record<string, string> = {
  'trackSchema.previewAvailable':
    'computed by db/catalog/serialize.ts from playability + the HLS ladder row count',
};

// ── The walk ────────────────────────────────────────────────────────────────

/**
 * Unwrap optionality wrappers and NOTHING else.
 *
 * Deliberately not the original's "call `.unwrap()` on anything that has it":
 * in zod 4 `ZodArray` has one and it returns the element type, which silently
 * turns an array field into a walk over its item shape.
 */
function unwrapOptional(type: z.ZodTypeAny): z.ZodTypeAny {
  let current = type;
  for (let depth = 0; depth < 10; depth += 1) {
    if (
      current instanceof z.ZodOptional
      || current instanceof z.ZodNullable
      || current instanceof z.ZodDefault
    ) {
      current = (current as unknown as { unwrap(): z.ZodTypeAny }).unwrap();
      continue;
    }
    const def = (current as unknown as { _def?: { innerType?: z.ZodTypeAny } })._def;
    if (def?.innerType) {
      current = def.innerType;
      continue;
    }
    break;
  }
  return current;
}

/** `a.b.cD` → `aBCD`, the flattening the port applied to every subdocument. */
function toColumnName(dotted: string): string {
  return dotted
    .split('.')
    .map((part, i) => (i === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join('');
}

type Resolution =
  | { kind: 'column'; column: string }
  | { kind: 'reference'; column: string }
  | { kind: 'renamed'; column: string }
  | { kind: 'child'; table: string }
  | { kind: 'derived'; reason: string }
  | undefined;

/** How `path` is stored for `dtoName`, or `undefined` if nothing accounts for it. */
function resolvePath(dtoName: string, path: string, columns: ReadonlySet<string>): Resolution {
  const key = `${dtoName}.${path}`;

  const renamed = RENAMED_COLUMN[key];
  if (renamed !== undefined) return { kind: 'renamed', column: renamed };

  const child = CHILD_TABLE[key];
  if (child !== undefined) return { kind: 'child', table: child };

  const derived = DERIVED[key];
  if (derived !== undefined) return { kind: 'derived', reason: derived };

  const column = toColumnName(path);
  if (columns.has(column)) return { kind: 'column', column };
  // A subdocument replaced by a foreign key: `imageSizes.small` is
  // `imageSizesSmallId`, and its leaf fields belong to `image_assets`.
  if (columns.has(`${column}Id`)) return { kind: 'reference', column: `${column}Id` };

  return undefined;
}

interface WalkResult {
  readonly resolved: string[];
  readonly unresolved: string[];
}

/**
 * Every DTO path, classified.
 *
 * **Descend only into what does not already resolve.** A path that resolves is a
 * leaf regardless of the zod type behind it, which is what makes a flattened
 * subdocument, a `jsonb` subdocument and a foreign key all come out right
 * without naming any of them.
 */
function walk(
  dtoName: string,
  shape: z.ZodObject<z.ZodRawShape>,
  columns: ReadonlySet<string>,
  prefix = '',
  depth = 0,
): WalkResult {
  const resolved: string[] = [];
  const unresolved: string[] = [];

  for (const [key, value] of Object.entries(shape.shape)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (resolvePath(dtoName, path, columns)) {
      resolved.push(path);
      continue;
    }

    const inner = unwrapOptional(value as z.ZodTypeAny);
    if (inner instanceof z.ZodObject && depth < 5) {
      const nested = walk(dtoName, inner as z.ZodObject<z.ZodRawShape>, columns, path, depth + 1);
      resolved.push(...nested.resolved);
      unresolved.push(...nested.unresolved);
      continue;
    }

    unresolved.push(path);
  }

  return { resolved, unresolved };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const TABLES: ReadonlyMap<string, PgTable> = new Map(
  (Object.entries(schema) as [string, unknown][])
    .filter((entry): entry is [string, PgTable] => isTable(entry[1])),
);

function columnsOf(exportName: string): ReadonlySet<string> {
  const table = TABLES.get(exportName);
  if (!table) throw new Error(`no such table export: ${exportName}`);
  return new Set(getTableConfig(table).columns.map((column) => column.name));
}

function dtoOf(name: string): z.ZodObject<z.ZodRawShape> {
  const dto = (dtos as Record<string, unknown>)[name];
  if (!(dto instanceof z.ZodObject)) throw new Error(`no such zod object DTO: ${name}`);
  return dto as z.ZodObject<z.ZodRawShape>;
}

// ── The gate ────────────────────────────────────────────────────────────────

describe('every zod DTO field resolves to drizzle storage', () => {
  /**
   * The vacuity floor. Every assertion below is "nothing unaccounted for", which
   * is exactly what a traversal that visited nothing also reports. These pin the
   * traversal on three independent axes so a break in any one cannot pass as a
   * clean sweep.
   */
  it('the scan is not vacuous', () => {
    expect(TABLES.size).toBeGreaterThanOrEqual(69);
    expect(Object.keys(DTO_FOR_TABLE).length).toBeGreaterThanOrEqual(12);

    // Per-DTO floor, reported as a list so a failure names the starved DTO
    // rather than just a number that got smaller.
    const tooFew = Object.entries(DTO_FOR_TABLE)
      .map(([tableName, dtoName]) => {
        const { resolved, unresolved } = walk(dtoName, dtoOf(dtoName), columnsOf(tableName));
        return { dtoName, count: resolved.length + unresolved.length };
      })
      .filter((entry) => entry.count < 5)
      .map((entry) => `${entry.dtoName} walked only ${entry.count} paths`);
    expect(tooFew).toEqual([]);

    const totalResolved = Object.entries(DTO_FOR_TABLE)
      .reduce((sum, [tableName, dtoName]) =>
        sum + walk(dtoName, dtoOf(dtoName), columnsOf(tableName)).resolved.length, 0);
    expect(totalResolved).toBeGreaterThanOrEqual(350);

    // Flattening must actually be exercised, or the nested drift this gate
    // exists to catch is invisible — the drizzle twin of the original's
    // `links.wikidata` check.
    const artist = walk('artistSchema', dtoOf('artistSchema'), columnsOf('catalogEntities'));
    expect(artist.resolved).toContain('links.wikidata');
    expect(artist.resolved).toContain('stats.followers');
    expect(artist.resolved).toContain('imageSizes.small');
    // ...and must NOT descend past a foreign key into the referenced table.
    expect(artist.resolved).not.toContain('imageSizes.small.width');

    // An array is ONE path, never a walk over its element shape. This is the
    // zod-4 `ZodArray.unwrap()` trap the Mongoose gate fell into.
    expect(artist.resolved).toContain('members');
    expect(artist.resolved.some((p) => p.startsWith('members.'))).toBe(false);

    // And the resolver must be capable of saying NO.
    expect(resolvePath('artistSchema', 'definitelyNotAField', columnsOf('catalogEntities')))
      .toBeUndefined();
    expect(resolvePath('artistSchema', 'links.definitelyNotAField', columnsOf('catalogEntities')))
      .toBeUndefined();
  });

  /**
   * Coverage, keyed on the enumerable side. A table added to the barrel is
   * neither checked nor knowingly skipped until it appears in exactly one of the
   * two registries — so under-coverage fails rather than passing silently.
   */
  it('every table is either paired with a DTO or declared DTO-less', () => {
    const paired = new Set(Object.keys(DTO_FOR_TABLE));
    const skipped = new Set(Object.keys(TABLES_WITHOUT_DTO));

    const unclassified = [...TABLES.keys()].filter((t) => !paired.has(t) && !skipped.has(t));
    expect(
      unclassified,
      'these tables are in the schema barrel but neither paired with a zod DTO nor listed '
        + 'in TABLES_WITHOUT_DTO. Add the pairing, or say why the table has no DTO.',
    ).toEqual([]);

    const both = [...paired].filter((t) => skipped.has(t));
    expect(both, 'a table cannot be both paired and DTO-less').toEqual([]);
  });

  /**
   * Staleness, in every registry. An entry naming something that no longer
   * exists is the shape that turns a gate back into a list: it stops matching,
   * nothing notices, and the field it used to account for goes unchecked.
   * Compared by identity against the real key sets — never containment.
   */
  it('no registry entry names a table or DTO that does not exist', () => {
    const tableNames = new Set(TABLES.keys());

    expect(
      Object.keys(DTO_FOR_TABLE).filter((t) => !tableNames.has(t)),
      'DTO_FOR_TABLE names tables that are not in the schema barrel',
    ).toEqual([]);
    expect(
      Object.keys(TABLES_WITHOUT_DTO).filter((t) => !tableNames.has(t)),
      'TABLES_WITHOUT_DTO names tables that are not in the schema barrel',
    ).toEqual([]);
    expect(
      Object.values(CHILD_TABLE).filter((t) => !tableNames.has(t)),
      'CHILD_TABLE points at tables that are not in the schema barrel',
    ).toEqual([]);

    const dtoNames = Object.values(DTO_FOR_TABLE);
    expect(
      dtoNames.filter((d) => !((dtos as Record<string, unknown>)[d] instanceof z.ZodObject)),
      'DTO_FOR_TABLE names zod schemas that are not exported object schemas',
    ).toEqual([]);

    // Every registry key is `<dtoSchemaName>.<path>`, and that DTO must be one
    // this gate actually walks — an entry for an unpaired DTO can never fire.
    const walked = new Set<string>(dtoNames);
    const orphans = [
      ...Object.keys(CHILD_TABLE),
      ...Object.keys(RENAMED_COLUMN),
      ...Object.keys(DERIVED),
    ].filter((key) => !walked.has(key.split('.')[0] ?? ''));
    expect(orphans, 'these registry entries name a DTO this gate does not walk').toEqual([]);
  });

  /**
   * The stale-entry half of "a registry is a list unless it discovers": an entry
   * whose path no longer exists on its DTO, or whose renamed column is gone from
   * the table, must FAIL rather than sit there matching nothing.
   */
  it('no registry entry points at a path or column that is gone', () => {
    const stale: string[] = [];

    for (const [tableName, dtoName] of Object.entries(DTO_FOR_TABLE)) {
      const columns = columnsOf(tableName);
      const { resolved } = walk(dtoName, dtoOf(dtoName), columns);
      const live = new Set(resolved);

      const prefix = `${dtoName}.`;
      for (const registry of [CHILD_TABLE, RENAMED_COLUMN, DERIVED]) {
        for (const key of Object.keys(registry)) {
          if (!key.startsWith(prefix)) continue;
          const path = key.slice(prefix.length);
          if (!live.has(path)) stale.push(`${key} — no such path on the DTO any more`);
        }
      }

      for (const [key, column] of Object.entries(RENAMED_COLUMN)) {
        if (!key.startsWith(prefix)) continue;
        if (!columns.has(column)) {
          stale.push(`${key} — points at column "${column}", which ${tableName} does not have`);
        }
      }
    }

    expect(
      stale,
      'these registry entries no longer match anything. A stale entry silently stops '
        + 'accounting for the field it names — remove it, or fix what it points at.',
    ).toEqual([]);
  });

  for (const [tableName, dtoName] of Object.entries(DTO_FOR_TABLE)) {
    it(`${dtoName}: every field resolves to storage in ${tableName}`, () => {
      const { unresolved } = walk(dtoName, dtoOf(dtoName), columnsOf(tableName));

      expect(
        unresolved,
        `${dtoName}: these fields are declared on the DTO and resolve to NO storage — not a `
          + `column on ${tableName}, not a foreign key, not a child table, not a rename. A field `
          + 'clients can read that the database never keeps is the `catalog_entities.members` '
          + 'defect. Add the column, or register it in CHILD_TABLE / RENAMED_COLUMN / DERIVED '
          + 'with a reason.',
      ).toEqual([]);
    });
  }
});
