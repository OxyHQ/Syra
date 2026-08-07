/**
 * Playlist reads and the two writes that are not one statement — on drizzle.
 *
 * `controllers/playlists.controller.ts` owns the HTTP shape; this module owns
 * the queries it would otherwise have inline, and the two operations that are
 * genuinely non-obvious: recomputing a playlist's stats from its playable
 * tracks, and moving track positions without tripping the unique constraint
 * that guards them.
 *
 * ## Reordering cannot be one `UPDATE`, and this was measured
 *
 * `unique(playlist_id, position)` is checked PER ROW as an `UPDATE` walks its
 * result, not once at the end — so the Mongo shift `updateMany({ order: { $gte:
 * n } }, { $inc: { order: k } })` has no direct translation. Verified against
 * the real server rather than assumed:
 *
 *     create table _t(a int, b int, unique(a, b));
 *     insert into _t values (1,0),(1,1),(1,2);
 *     update _t set b = b + 1 where a = 1;
 *     -- ERROR: duplicate key value violates unique constraint "_t_a_b_key"
 *     -- DETAIL: Key (a, b)=(1, 1) already exists.
 *
 * A `DEFERRABLE` constraint would sidestep it, but drizzle-orm 0.45.2 has no
 * typed API for one, so the schema would say something the migration did not.
 * {@link assignPlaylistTrackPositions} takes the other route: inside one
 * transaction it first lifts EVERY row of the playlist above its own current
 * maximum, then writes the final positions, which are all at or below that
 * maximum. Neither statement can collide, and the argument is arithmetic
 * rather than a claim about statement ordering.
 *
 * The same constraint exists on Mongo (`PlaylistTrackSchema.index({ playlistId:
 * 1, order: 1 }, { unique: true })`), so an arbitrary reorder there is a
 * duplicate-key error too wherever that index was actually built. This is a
 * latent bug the port turns into a certainty and then fixes, not one the port
 * introduces.
 */

import { and, asc, count, eq, inArray, sql, sum } from 'drizzle-orm';
import { union } from 'drizzle-orm/pg-core';
import type { PlaylistCollaborator } from '@syra/shared-types';
import { getDb, type DbOrTransaction, type DbTransaction } from '../postgres';
import { tracks } from '../schema/catalog';
import { playlistCollaborators, playlistTracks, playlists } from '../schema/library';
import { playableTrackFilter } from '../catalog/visibility';
import type { PlaylistRow } from '../catalog/serialize';

/** One playlist row, or `undefined` when no such playlist exists. */
export async function findPlaylistById(id: string): Promise<PlaylistRow | undefined> {
  const [row] = await getDb().select().from(playlists).where(eq(playlists.id, id)).limit(1);
  return row;
}

/**
 * Every collaborator of a playlist, as the DTO renders them.
 *
 * Ordered by `addedAt` so the list is stable between requests: the embedded
 * Mongo array had an order and a table has none, and an unordered list that
 * changes between two identical requests reads to a client as a change.
 */
export async function findPlaylistCollaborators(
  playlistId: string
): Promise<PlaylistCollaborator[]> {
  const rows = await getDb()
    .select({
      oxyUserId: playlistCollaborators.oxyUserId,
      username: playlistCollaborators.username,
      role: playlistCollaborators.role,
      addedAt: playlistCollaborators.addedAt,
    })
    .from(playlistCollaborators)
    .where(eq(playlistCollaborators.playlistId, playlistId))
    .orderBy(asc(playlistCollaborators.addedAt));

  return rows.map((row) => ({
    oxyUserId: row.oxyUserId,
    username: row.username,
    role: row.role,
    addedAt: row.addedAt.toISOString(),
  }));
}

/**
 * A viewer's role on a playlist, or `undefined` when they hold none.
 *
 * One indexed point lookup on `unique(playlist_id, oxy_user_id)` rather than
 * loading the whole collaborator list to search it in memory, which is what
 * the Mongo version did with an embedded array.
 */
export async function findCollaboratorRole(
  playlistId: string,
  oxyUserId: string
): Promise<PlaylistCollaborator['role'] | undefined> {
  const [row] = await getDb()
    .select({ role: playlistCollaborators.role })
    .from(playlistCollaborators)
    .where(
      and(
        eq(playlistCollaborators.playlistId, playlistId),
        eq(playlistCollaborators.oxyUserId, oxyUserId)
      )
    )
    .limit(1);

  return row?.role;
}

/** Every collaborator's account id — what `canViewPlaylist` asks about. */
export async function findCollaboratorOxyUserIds(playlistId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ oxyUserId: playlistCollaborators.oxyUserId })
    .from(playlistCollaborators)
    .where(eq(playlistCollaborators.playlistId, playlistId));

  return rows.map((row) => row.oxyUserId);
}

/**
 * Every playlist a user owns or collaborates on, images first then newest.
 *
 * A UNION of two independently indexed selects, and NOT the single `SELECT`
 * with `owner = $1 OR id IN (…)` that this was first written as. Postgres
 * resolves that subquery into `= ANY (hashed SubPlan)`, which is not an
 * indexable condition, so the whole disjunction falls to a Seq Scan — even
 * under `enable_seqscan = off`, and a correlated `EXISTS` plans identically.
 * Measured against 4,000 playlists: 373 buffers and 59.8 ms for the `OR`,
 * against 22 buffers and 0.056 ms for this. `__tests__/library.explain.test.ts`
 * keeps BOTH shapes as probes, so the rejected one is asserted to still scan
 * rather than described here as if it were obvious.
 *
 * The union is wrapped in a subquery because `ORDER BY` after a set operation
 * accepts only result column NAMES, not expressions — and the first ordering
 * term is `(cover_art_id is not null)`.
 */
export async function findPlaylistsForUser(oxyUserId: string): Promise<PlaylistRow[]> {
  const reachable = union(
    getDb().select().from(playlists).where(eq(playlists.ownerOxyUserId, oxyUserId)),
    getDb()
      .select()
      .from(playlists)
      .where(
        inArray(
          playlists.id,
          getDb()
            .select({ id: playlistCollaborators.playlistId })
            .from(playlistCollaborators)
            .where(eq(playlistCollaborators.oxyUserId, oxyUserId))
        )
      )
  ).as('reachable');

  return getDb()
    .select()
    .from(reachable)
    // `is not null` rather than the Mongo helper's `{ coverArt: -1 }`, which
    // also tie-broke by the lexical value of the image id and took precedence
    // over the date the caller actually sorted by. See `db/catalog/
    // containers.ts`'s `imageFirst`, which this is the inlined form of —
    // inlined because it has to address the union's columns, not the table's.
    .orderBy(sql`(${reachable.coverArtId} is not null) desc`, sql`${reachable.createdAt} desc`);
}

/** One playlist's tracks, in playlist order. */
export async function findPlaylistTracks(
  playlistId: string
): Promise<{ trackId: string; addedAt: Date; addedBy: string | null; position: number }[]> {
  return getDb()
    .select({
      trackId: playlistTracks.trackId,
      addedAt: playlistTracks.addedAt,
      addedBy: playlistTracks.addedBy,
      position: playlistTracks.position,
    })
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, playlistId))
    .orderBy(asc(playlistTracks.position));
}

/**
 * Recompute `track_count` and `total_duration` from the playlist's PLAYABLE
 * tracks.
 *
 * One statement where Mongo needed three round trips and a `Map`: the join is
 * the same `playable_track_filter` every catalog read composes, so a track
 * taken down stops counting towards a playlist's duration without any
 * playlist-side bookkeeping.
 *
 * `duration` is nullable, so the `sum` is nullable too and Postgres returns it
 * as a numeric STRING — coerced once here rather than at the call site, where
 * a string silently concatenating into a total would look like a very long
 * playlist.
 */
export async function refreshPlaylistStats(
  db: DbOrTransaction,
  playlistId: string
): Promise<void> {
  const [stats] = await db
    .select({ trackCount: count(), totalDuration: sum(tracks.duration) })
    .from(playlistTracks)
    .innerJoin(tracks, eq(tracks.id, playlistTracks.trackId))
    .where(and(eq(playlistTracks.playlistId, playlistId), playableTrackFilter()));

  await db
    .update(playlists)
    .set({
      trackCount: stats?.trackCount ?? 0,
      totalDuration: Number(stats?.totalDuration ?? 0),
    })
    .where(eq(playlists.id, playlistId));
}

/**
 * Write a new position for each named track, collision-free.
 *
 * `ordered` is the track ids in their final order; every track of the playlist
 * that is not named keeps a position too, so this takes the WHOLE playlist and
 * assigns `0…n-1`. Callers that only move part of a playlist compute the full
 * order first — which is what both of them were already doing.
 *
 * Two statements inside the caller's transaction:
 *
 *  1. Lift every row of the playlist by `max(position) + 1`. Every new value
 *     is strictly greater than every old one, so no row can land on another.
 *  2. Write the finals, all of which are `< max + 1` and therefore below every
 *     value now in the table.
 *
 * See this file's doc comment for why a single `UPDATE` cannot do this.
 */
export async function assignPlaylistTrackPositions(
  tx: DbTransaction,
  playlistId: string,
  ordered: readonly string[]
): Promise<void> {
  if (ordered.length === 0) return;

  const [current] = await tx
    .select({ highest: sql<number | null>`max(${playlistTracks.position})` })
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, playlistId));

  const lift = (current?.highest ?? -1) + 1;

  await tx
    .update(playlistTracks)
    .set({ position: sql`${playlistTracks.position} + ${lift}` })
    .where(eq(playlistTracks.playlistId, playlistId));

  // One statement per track rather than one `UPDATE … FROM (VALUES …)`: the
  // playlist has already been lifted clear, so these cannot collide with each
  // other either, and a VALUES list would have to bind the ids as `text` and
  // cast them back — a seam worth more than the round trips it saves on lists
  // this size.
  for (const [position, trackId] of ordered.entries()) {
    await tx
      .update(playlistTracks)
      .set({ position })
      .where(and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.trackId, trackId)));
  }
}

/**
 * The playable subset of a set of track ids, as ids.
 *
 * `inArray(column, [])` generates `in ()` — a Postgres SYNTAX ERROR rather
 * than an empty result — so the empty case is answered without a query, the
 * same guard `db/catalog/hydrate.ts` carries.
 */
export async function findPlayableTrackIds(ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];

  const rows = await getDb()
    .select({ id: tracks.id })
    .from(tracks)
    .where(and(playableTrackFilter(), inArray(tracks.id, [...ids])));

  return rows.map((row) => row.id);
}

/** Which of these tracks the playlist already holds. */
export async function findExistingPlaylistTrackIds(
  playlistId: string,
  trackIds: readonly string[]
): Promise<string[]> {
  if (trackIds.length === 0) return [];

  const rows = await getDb()
    .select({ trackId: playlistTracks.trackId })
    .from(playlistTracks)
    .where(
      and(eq(playlistTracks.playlistId, playlistId), inArray(playlistTracks.trackId, [...trackIds]))
    );

  return rows.map((row) => row.trackId);
}
