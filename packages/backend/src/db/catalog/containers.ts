/**
 * Track-bearing containers — albums, artists and playlists that hold at least
 * one playable track.
 *
 * ## Joins are typed by construction
 *
 * With real foreign keys both sides of every join are the same type, so these
 * are ordinary indexed joins with no type conversion to place. Filters compose
 * with drizzle's `and()`.
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
 * `tracks` rather than with the album. Migration `0016` adds a standalone
 * `album_id` index and
 * `__tests__/containers.explain.test.ts` asserts the planner actually reaches it
 * rather than asserting the definition exists.
 *
 * ## What these queries do NOT do
 *
 * They are O(containers), not O(limit). Postgres plans
 * `semi join -> top-N sort -> limit`, and it does not walk an ordered index to
 * stop early: forcing `enable_hashjoin=off`, `enable_mergejoin=off`,
 * `enable_sort=off` and `enable_seqscan=off` in every combination still sorts
 * after the join. The join itself is indexed, but "the relational form
 * evaluates only the page it returns" would be false,
 * so it is not claimed anywhere.
 */

import { and, asc, count, desc, eq, exists, sql, type SQL } from 'drizzle-orm';
import { unionAll, type PgColumn } from 'drizzle-orm/pg-core';
import { publicColumns } from '@oxy.so/db/assert';
import { albums, catalogEntities, trackCredits, tracks } from '../schema/catalog';
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
 *   descNullsLast()   cost    4.34  — Index Scan using tracks_created_at_idx, stops at 20
 *
 * ~250x, and it scales with the catalogue rather than with the page. The index
 * was there the whole time; nothing could reach it.
 *
 * (An earlier revision of this comment quoted 7.04 for the second row, from a
 * run before the EXPLAIN seed gave `created_at` varying values. Both runs show
 * the same thing; the number here is the one the probe now reproduces, because
 * this is the copy that gets quoted later.)
 *
 * ## It is also the FAITHFUL ordering
 *
 * This is not a performance hack traded against behaviour. Artists with no
 * follower count belong LAST on a most-followed shelf — which is `NULLS LAST`.
 * `desc()` would move them to the front of every shelf.
 */
export function descNullsLast(column: PgColumn): SQL {
  return sql`${column} desc nulls last`;
}

/**
 * "Rows that have an image first".
 *
 * Sorting descending on the image column itself would express the intent only
 * incidentally: it puts non-null values ahead of missing ones, but it ALSO
 * orders the rows that do have an image by the lexical value of their image id
 * — an arbitrary tie-break nobody asked for, which would then take precedence
 * over the popularity or date the caller actually sorted by.
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
      .where(and(eq(containerColumn, containerId), playableTrackFilter())),
  );
}

/**
 * Album visibility: an album is hidden when its creator unpublishes the
 * CONTAINER, independently of whether its tracks are still individually
 * playable.
 *
 * `albums.is_available` is `NOT NULL DEFAULT true`, so absent is
 * unrepresentable and the exact equality is correct as well as indexable.
 */
function availableAlbum(): SQL {
  return eq(albums.isAvailable, true);
}

/**
 * `catalog_entities` holds both artists and persons in one table. Implicit
 * scoping is a bug class (any read path that bypasses it sees both kinds), so
 * there is no implicit scoping here at all: this condition is written out, and a
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

/**
 * "Has a playable track CREDITING this artist", for the artists who own none.
 *
 * A featured guest owns nothing: the recording belongs to the principal, and
 * the guest exists only as a `track_credits` row carrying their entity id. So
 * `tracks.artist_id` never points at them, and an ownership-only predicate
 * makes their page 404 — for exactly the artists a multi-artist credit exists
 * to surface. The credit rendered their name, the name linked, and the link was
 * dead.
 *
 * Matched on `catalog_entity_id`, never on the name: a credit whose id is null
 * is a name off a file tag, which is not a claim that this artist was on the
 * record, and letting it summon a page would be the identity guess the credits
 * schema refuses to make.
 *
 * Their page is not empty either — `artistProfile`'s "credited on" section
 * already renders precisely these tracks. It could just never be reached.
 */
/**
 * "This artist OWNS a playable track, or is CREDITED on one."
 *
 * A featured guest owns nothing: the recording belongs to the principal, and
 * the guest exists only as a `track_credits` row carrying their entity id. So
 * `tracks.artist_id` never points at them, and an ownership-only predicate made
 * their page 404 — for exactly the artists a multi-artist credit exists to
 * surface. The credit rendered their name, the name linked, and the link was
 * dead. Their page is not empty either: `artistProfile`'s "credited on" section
 * already renders precisely these tracks. It could just never be reached.
 *
 * ## Why ONE `exists` over a `union all`, and not two joined by `or`
 *
 * The obvious spelling — `exists(owns) or exists(credited)` — is measurably
 * worse, because an `or` of two correlated subqueries blocks the semi-join
 * transformation: Postgres stops pushing `= ce.id` into either branch and
 * evaluates both wholesale. Measured on a 200-artist / 4,000-track /
 * 600-credit seed with `enable_seqscan = off` (the gate's setting), listing
 * the top 20 artists:
 *
 *   or of two exists   0.792 ms  — ownership scans all 3,430 playable tracks
 *                                  with NO index condition; the credit branch
 *                                  scans `track_credits` whole
 *   exists(union all)  0.307 ms  — `Index Cond: (artist_id = ce.id)` AND
 *                                  `Index Cond: (catalog_entity_id = ce.id)`
 *
 * Under `union all` each branch keeps its own correlation, so both reach their
 * index and the probe stops at the first matching row — the property this whole
 * module is built around. The difference is structural, not a cost-estimate
 * accident, which is why the spelling is load-bearing and commented here.
 *
 * The credit side matches on `catalog_entity_id`, never on the name: a credit
 * whose id is null is a name off a file tag, not a claim that this artist was
 * on the record, and letting it summon a page would be the identity guess the
 * credits schema deliberately refuses to make.
 */
function hasPlayableTrackOrCredit(): SQL {
  const owns = getDb()
    .select({ present: sql`1` })
    .from(tracks)
    .where(and(eq(tracks.artistId, catalogEntities.id), playableTrackFilter()));

  const credited = getDb()
    .select({ present: sql`1` })
    .from(trackCredits)
    .innerJoin(tracks, eq(tracks.id, trackCredits.trackId))
    .where(and(eq(trackCredits.catalogEntityId, catalogEntities.id), playableTrackFilter()));

  return exists(unionAll(owns, credited));
}

export function playableArtistsWhere(): SQL {
  return and(artistEntity(), hasPlayableTrackOrCredit()) as SQL;
}

/**
 * One level deeper than the album and artist predicates, because playlist
 * membership lives in `playlist_tracks`.
 *
 * `playlist_tracks.track_id` is a real foreign key to `tracks.id`, so the inner
 * probe is a primary-key lookup and there is no
 * conversion to place.
 */
export function playablePlaylistsWhere(): SQL {
  return exists(
    getDb()
      .select({ present: sql`1` })
      .from(playlistTracks)
      .innerJoin(tracks, eq(tracks.id, playlistTracks.trackId))
      .where(and(eq(playlistTracks.playlistId, playlists.id), playableTrackFilter())),
  );
}

/** `where` composed with an optional caller-supplied condition. */
function narrowed(base: SQL, extra?: SQL): SQL {
  return extra ? (and(base, extra) as SQL) : base;
}

// ── Albums ────────────────────────────────────────────────────────────────

export async function findAlbumsWithPlayableTracks(
  where: SQL | undefined,
  page: CatalogPage,
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
    .where(and(eq(albums.id, id), playableAlbumsWhere()))
    .limit(1);

  return row ?? null;
}

// ── Artists ───────────────────────────────────────────────────────────────

export async function findArtistsWithPlayableTracks(
  where: SQL | undefined,
  page: CatalogPage,
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
  id: string,
): Promise<PublicCatalogEntityRow | null> {
  const [row] = await getDb()
    .select(publicColumns(catalogEntities, PROTECTED_COLUMNS_BY_TABLE))
    .from(catalogEntities)
    .where(and(eq(catalogEntities.id, id), playableArtistsWhere()))
    .limit(1);

  return row ?? null;
}

// ── Playlists ─────────────────────────────────────────────────────────────

export async function findPlaylistsWithPlayableTracks(
  where: SQL | undefined,
  page: CatalogPage,
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
