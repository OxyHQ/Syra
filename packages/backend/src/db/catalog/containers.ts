/**
 * Track-bearing containers — albums, artists and playlists that hold at least
 * one playable track. The drizzle replacement for `utils/playableContainers.ts`.
 *
 * ## The `$lookup` / `$convert` rule evaporates
 *
 * The Mongo pipelines carried a rule with its own paragraph in `AGENTS.md`:
 * when a `$lookup` correlates fields of different BSON types, convert on the
 * LOCAL side in `let` and leave the foreign field a bare path, or the comparison
 * becomes unindexable and every lookup degrades into a collection scan. That
 * existed because `PlaylistTrack.trackId` was a string while `Track._id` was an
 * ObjectId — a mismatch the schema itself created.
 *
 * With real foreign keys the two sides are the same type by construction, so
 * these are ordinary indexed joins and the rule has nothing left to apply to.
 * It is deleted rather than translated, along with `andMongoFilters`: drizzle
 * composes with `and()`.
 *
 * ## What was measured, and the one index that was missing
 *
 * Every query here was run under `EXPLAIN (ANALYZE, BUFFERS)` against a seeded
 * database (3,000 artists / 8,000 albums / 60,000 tracks / 2,000 playlists /
 * 80,000 playlist-track rows), and again under `SET enable_seqscan = off`.
 *
 * The artist and playlist paths reached index-only scans as designed. The ALBUM
 * path did not, and the reason is worth recording: `schema/catalog.ts` ships
 * `tracks_artist_id_album_id_idx` on `(artist_id, album_id)` and no standalone
 * `album_id` index, and Postgres 17 has no index skip scan — so a probe keyed on
 * `album_id` alone had to scan that whole partial index. `GET /albums/:id/tracks`
 * cost 190 buffers where 9 sufficed, and the cost scaled with the size of
 * `tracks` rather than with the album. `models/Track.ts:134` declares
 * `albumId: { type: String, index: true }`, so Mongo had the index and the port
 * had dropped it; migration `0016` restores it and
 * `__tests__/containers.explain.test.ts` asserts the planner actually reaches it
 * rather than asserting the definition exists.
 *
 * ## What these queries do NOT do
 *
 * They are O(containers), not O(limit). Postgres plans
 * `semi join -> top-N sort -> limit`, and it does not walk an ordered index to
 * stop early: forcing `enable_hashjoin=off`, `enable_mergejoin=off`,
 * `enable_sort=off` and `enable_seqscan=off` in every combination still sorts
 * after the join. That is a real improvement over the Mongo pipelines — which
 * ran the `$lookup` before `$sort`/`$limit` AND could not index the correlation
 * — but "the relational form evaluates only the page it returns" would be false,
 * so it is not claimed anywhere.
 */

import { and, asc, count, desc, eq, exists, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { publicColumns } from '@oxyhq/db/assert';
import { albums, catalogEntities, tracks } from '../schema/catalog';
import { playlistTracks, playlists } from '../schema/library';
import { PROTECTED_COLUMNS_BY_TABLE } from '../schema/protectedColumns';
import { getDb } from '../postgres';
import { playableTrackFilter } from './visibility';
import type { AlbumRow, PlaylistRow, PublicCatalogEntityRow } from './serialize';

/** How a page of containers is ordered and sliced. */
export interface CatalogPage {
  /** Drizzle columns or expressions; `asc()`/`desc()` are re-exported below. */
  readonly orderBy: readonly (SQL | PgColumn)[];
  readonly limit: number;
  readonly offset?: number;
}

// Re-exported so a caller building a `CatalogPage` does not have to import
// drizzle's ordering helpers separately alongside this module.
export { asc, desc };

/**
 * "Biggest first, and absent values last" — the ordering term every descending
 * catalog listing must use instead of drizzle's `desc()`.
 *
 * ## The mismatch, measured
 *
 * Every descending index in this schema is declared `DESC NULLS LAST`, because
 * that is what drizzle's `.desc()` emits. A bare SQL `ORDER BY col DESC` means
 * `DESC NULLS FIRST`. Postgres matches an index to an ordering SYNTACTICALLY,
 * including nulls placement, so the two never match — and the consequence is
 * not subtle: the index is still chosen, but only as a predicate scan, with a
 * full sort on top.
 *
 * `GET /api/tracks` (`order by created_at desc limit 20`) on the 4,000-row
 * EXPLAIN seed, same transaction, same statistics:
 *
 *   desc()            cost 1087.00  — Index Scan + Sort of all 3,430 playable rows
 *   descNullsLast()   cost    7.04  — Index Scan using tracks_created_at_idx, stops at 20
 *
 * 155x, and it scales with the catalogue rather than with the page. The index
 * was there the whole time; nothing could reach it.
 *
 * ## It is also the FAITHFUL ordering
 *
 * This is not a performance hack traded against behaviour. Mongo sorts a missing
 * field as the lowest value, so `{ 'stats.followers': -1 }` put artists with no
 * follower count LAST — which is `NULLS LAST`. `desc()` would have moved them to
 * the front of every shelf.
 */
export function descNullsLast(column: PgColumn): SQL {
  return sql`${column} desc nulls last`;
}

/**
 * "Rows that have an image first" — the replacement for `utils/imageFirstSort.ts`.
 *
 * The Mongo helper prepended `{ coverArt: -1 }` (or `{ image: -1 }`) to a sort
 * document. That expressed the intent only incidentally: descending on a string
 * field puts non-null values ahead of missing ones, but it ALSO orders the rows
 * that do have an image by the lexical value of their image id — an arbitrary
 * tie-break nobody asked for, which then took precedence over the popularity or
 * date the caller actually sorted by, since it came first in the document.
 *
 * This sorts on the PREDICATE instead, so it separates "has an image" from "has
 * none" and leaves every subsequent ordering term to do the rest. It is the
 * intent the old helper was reaching for, and the difference is visible on any
 * shelf where two artists both have photographs.
 */
export function imageFirst(column: PgColumn): SQL {
  return sql`(${column} is not null) desc`;
}

/**
 * "This album has at least one playable track", as a correlated `EXISTS`.
 *
 * `exists()` rather than a join: a join would multiply the container row by its
 * track count and need a `DISTINCT` to undo it, and Postgres stops an `EXISTS`
 * probe at the first matching row.
 */
function hasPlayableTrack(containerColumn: PgColumn, containerId: PgColumn): SQL {
  return exists(
    getDb()
      .select({ present: sql`1` })
      .from(tracks)
      .where(and(eq(containerColumn, containerId), playableTrackFilter()))
  );
}

/**
 * Album visibility: an album is hidden when its creator unpublishes the
 * CONTAINER, independently of whether its tracks are still individually
 * playable.
 *
 * The Mongo filter was `{ isAvailable: { $ne: false } }` — "absent counts as
 * available", so existing albums needed no backfill. `albums.is_available` is
 * `NOT NULL DEFAULT true` here, so absent is unrepresentable and the exact
 * equality is equivalent as well as indexable.
 */
function availableAlbum(): SQL {
  return eq(albums.isAvailable, true);
}

/**
 * `catalog_entities` holds both artists and persons in one table. Mongoose's
 * discriminator injected `{ type: 'artist' }` into `find()` but NOT into
 * `aggregate()`, and every container read was an aggregation — a live bug class.
 * There is no implicit scoping here at all: this condition is written out, and a
 * reader can see it.
 */
function artistEntity(): SQL {
  return eq(catalogEntities.type, 'artist');
}

/**
 * The COMPLETE predicate each container listing runs under, exported as one
 * condition each.
 *
 * One spelling, three consumers: the finders and counters below, a Task 10b
 * caller composing its own query, and `__tests__/containers.explain.test.ts`,
 * which EXPLAINs these rather than a hand-written lookalike. The lookalike is
 * the trap — a probe that reconstructs "roughly the shipped query" measures a
 * plan nothing runs, and drifts silently the moment this file changes.
 */
export function playableAlbumsWhere(): SQL {
  return and(availableAlbum(), hasPlayableTrack(tracks.albumId, albums.id)) as SQL;
}

export function playableArtistsWhere(): SQL {
  return and(artistEntity(), hasPlayableTrack(tracks.artistId, catalogEntities.id)) as SQL;
}

/**
 * One level deeper than the album and artist predicates, because playlist
 * membership lives in `playlist_tracks`.
 *
 * Under Mongo this was the nested `$lookup` that made playlist-bearing endpoints
 * take 20 s: `PlaylistTrack.trackId` was a string and `Track._id` an ObjectId, so
 * the correlation could not use an index unless the conversion was applied on
 * exactly the right side. `playlist_tracks.track_id` is a real foreign key to
 * `tracks.id` now, so the inner probe is a primary-key lookup and there is no
 * conversion to place.
 */
export function playablePlaylistsWhere(): SQL {
  return exists(
    getDb()
      .select({ present: sql`1` })
      .from(playlistTracks)
      .innerJoin(tracks, eq(tracks.id, playlistTracks.trackId))
      .where(and(eq(playlistTracks.playlistId, playlists.id), playableTrackFilter()))
  );
}

/** `where` composed with an optional caller-supplied condition. */
function narrowed(base: SQL, extra?: SQL): SQL {
  return extra ? (and(base, extra) as SQL) : base;
}

// ── Albums ────────────────────────────────────────────────────────────────

export async function findAlbumsWithPlayableTracks(
  where: SQL | undefined,
  page: CatalogPage
): Promise<AlbumRow[]> {
  const query = getDb()
    .select(publicColumns(albums, PROTECTED_COLUMNS_BY_TABLE))
    .from(albums)
    .where(narrowed(playableAlbumsWhere(), where))
    .orderBy(...page.orderBy)
    .limit(page.limit);

  return page.offset && page.offset > 0 ? query.offset(page.offset) : query;
}

export async function countAlbumsWithPlayableTracks(where?: SQL): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(albums)
    .where(narrowed(playableAlbumsWhere(), where));

  return row?.total ?? 0;
}

export async function findOneAlbumWithPlayableTracks(id: string): Promise<AlbumRow | null> {
  const [row] = await getDb()
    .select(publicColumns(albums, PROTECTED_COLUMNS_BY_TABLE))
    .from(albums)
    .where(
      and(eq(albums.id, id), playableAlbumsWhere())
    )
    .limit(1);

  return row ?? null;
}

// ── Artists ───────────────────────────────────────────────────────────────

export async function findArtistsWithPlayableTracks(
  where: SQL | undefined,
  page: CatalogPage
): Promise<PublicCatalogEntityRow[]> {
  const query = getDb()
    .select(publicColumns(catalogEntities, PROTECTED_COLUMNS_BY_TABLE))
    .from(catalogEntities)
    .where(narrowed(playableArtistsWhere(), where))
    .orderBy(...page.orderBy)
    .limit(page.limit);

  return page.offset && page.offset > 0 ? query.offset(page.offset) : query;
}

export async function countArtistsWithPlayableTracks(where?: SQL): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(catalogEntities)
    .where(narrowed(playableArtistsWhere(), where));

  return row?.total ?? 0;
}

export async function findOneArtistWithPlayableTracks(
  id: string
): Promise<PublicCatalogEntityRow | null> {
  const [row] = await getDb()
    .select(publicColumns(catalogEntities, PROTECTED_COLUMNS_BY_TABLE))
    .from(catalogEntities)
    .where(
      and(eq(catalogEntities.id, id), playableArtistsWhere())
    )
    .limit(1);

  return row ?? null;
}

// ── Playlists ─────────────────────────────────────────────────────────────

export async function findPlaylistsWithPlayableTracks(
  where: SQL | undefined,
  page: CatalogPage
): Promise<PlaylistRow[]> {
  const query = getDb()
    .select(publicColumns(playlists, PROTECTED_COLUMNS_BY_TABLE))
    .from(playlists)
    .where(narrowed(playablePlaylistsWhere(), where))
    .orderBy(...page.orderBy)
    .limit(page.limit);

  return page.offset && page.offset > 0 ? query.offset(page.offset) : query;
}

export async function countPlaylistsWithPlayableTracks(where?: SQL): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(playlists)
    .where(narrowed(playablePlaylistsWhere(), where));

  return row?.total ?? 0;
}

// ── Tracks of one container ───────────────────────────────────────────────

/**
 * The playable tracks of one album, in disc/track order — `GET /albums/:id/tracks`
 * and the album queue seed, which must agree.
 *
 * This is the query migration `0016`'s index exists for; see this file's
 * doc comment.
 */
export function playableAlbumTracksWhere(albumId: string): SQL {
  return and(eq(tracks.albumId, albumId), playableTrackFilter()) as SQL;
}

/** Disc-then-track ordering, shared by every album track listing. */
export const ALBUM_TRACK_ORDER: readonly (SQL | PgColumn)[] = [
  asc(tracks.discNumber),
  asc(tracks.trackNumber),
];
