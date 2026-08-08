/**
 * The four library memberships, on drizzle — the replacement for
 * `UserLibrary`'s arrays.
 *
 * `models/Library.ts` held one document per user carrying five string arrays.
 * Four of them are ported here as real junction tables. The fifth,
 * `subscribedPodcasts`, could not move with them — `user_podcast_subscriptions`
 * references `podcasts`, and nothing wrote that table yet, so a drizzle insert
 * would have failed `23503` against an empty one. Task 12 ported its writer and
 * took the array with it; it lives in `db/podcasts/subscriptions.ts` rather than
 * here, beside the rest of that vertical, and `models/Library.ts` is deleted.
 *
 * ## What `$addToSet` promised and a unique constraint delivers
 *
 * The Mongo handlers were idempotent by using `$addToSet`/`$pull` on an array,
 * which is a set operation only for as long as every writer remembers to use
 * one. `unique(oxy_user_id, <target>_id)` on each table below is the same
 * property enforced by the database, and `onConflictDoNothing()` is what turns
 * a second like of the same track back into a no-op rather than a `23505`.
 *
 * ## Adding can now fail, and removing still cannot
 *
 * This is the one place the ported behaviour genuinely differs from Mongo, and
 * it is not a choice: every target column is a real foreign key, so liking a
 * track that does not exist is `23503` where Mongo silently stored the string.
 * {@link addMembership} answers `'missing-target'` for exactly that constraint
 * and the controller turns it into a 404 — a bogus id must not reach a client
 * as a 500.
 *
 * Removal is unchanged: a `delete` matching nothing removes nothing, which is
 * what the Mongo `$pull` (against an upserted, possibly empty document) also
 * did. Unliking a track that never existed is still a successful no-op, and
 * that asymmetry is deliberate — the foreign key constrains what may be
 * STORED, not what may be asked for.
 *
 * ## Why the four relations are spelled out rather than parameterised
 *
 * The tables differ in the one column that matters (`track_id`, `album_id`,
 * `artist_id`, `playlist_id`), so a single helper taking a `PgColumn` would
 * have to select through an un-narrowed column type and cast the result back
 * to `string`. That is the same untyped seam that let a drizzle row reach
 * `formatTracksWithCoverArt(tracks: any[])` and answer `{"id":""}` from four
 * live endpoints. Three named statements each, fully typed, no casts.
 */

import { and, asc, eq } from 'drizzle-orm';
import { isForeignKeyViolation } from '@oxyhq/db';
import { getDb } from '../postgres';
import {
  userFollowedArtists,
  userLikedTracks,
  userSavedAlbums,
  userSavedPlaylists,
} from '../schema/library';

/** The four memberships `controllers/library.controller.ts` exposes. */
export type MembershipKind =
  | 'likedTracks'
  | 'savedAlbums'
  | 'followedArtists'
  | 'savedPlaylists';

interface MembershipRelation {
  /**
   * One user's ids, OLDEST FIRST — the order the Mongo array had, since
   * `$addToSet` appends. Two callers read it as an order rather than a set:
   * `services/radio/radioSeed.ts` takes the freshest likes off the tail, and
   * `controllers/library.controller.ts` hands the list to a client that
   * renders it in the order it arrives.
   */
  readonly list: (oxyUserId: string) => Promise<{ targetId: string }[]>;
  readonly insert: (oxyUserId: string, targetId: string) => Promise<unknown>;
  readonly remove: (oxyUserId: string, targetId: string) => Promise<unknown>;
  /**
   * The foreign key that fires when the target does not exist, BY NAME.
   *
   * Named rather than matched on the bare SQLSTATE, per `@oxyhq/db`'s
   * `isForeignKeyViolation` contract: a second foreign key added to one of
   * these tables tomorrow would otherwise reach the client as "no such track".
   */
  readonly missingTargetConstraint: string;
}

const RELATIONS: Readonly<Record<MembershipKind, MembershipRelation>> = {
  likedTracks: {
    list: (oxyUserId) =>
      getDb()
        .select({ targetId: userLikedTracks.trackId })
        .from(userLikedTracks)
        .where(eq(userLikedTracks.oxyUserId, oxyUserId))
        .orderBy(asc(userLikedTracks.createdAt)),
    insert: (oxyUserId, trackId) =>
      getDb().insert(userLikedTracks).values({ oxyUserId, trackId }).onConflictDoNothing(),
    remove: (oxyUserId, trackId) =>
      getDb()
        .delete(userLikedTracks)
        .where(and(eq(userLikedTracks.oxyUserId, oxyUserId), eq(userLikedTracks.trackId, trackId))),
    missingTargetConstraint: 'user_liked_tracks_track_id_tracks_id_fk',
  },
  savedAlbums: {
    list: (oxyUserId) =>
      getDb()
        .select({ targetId: userSavedAlbums.albumId })
        .from(userSavedAlbums)
        .where(eq(userSavedAlbums.oxyUserId, oxyUserId))
        .orderBy(asc(userSavedAlbums.createdAt)),
    insert: (oxyUserId, albumId) =>
      getDb().insert(userSavedAlbums).values({ oxyUserId, albumId }).onConflictDoNothing(),
    remove: (oxyUserId, albumId) =>
      getDb()
        .delete(userSavedAlbums)
        .where(and(eq(userSavedAlbums.oxyUserId, oxyUserId), eq(userSavedAlbums.albumId, albumId))),
    missingTargetConstraint: 'user_saved_albums_album_id_albums_id_fk',
  },
  followedArtists: {
    list: (oxyUserId) =>
      getDb()
        .select({ targetId: userFollowedArtists.artistId })
        .from(userFollowedArtists)
        .where(eq(userFollowedArtists.oxyUserId, oxyUserId))
        .orderBy(asc(userFollowedArtists.createdAt)),
    insert: (oxyUserId, artistId) =>
      getDb().insert(userFollowedArtists).values({ oxyUserId, artistId }).onConflictDoNothing(),
    remove: (oxyUserId, artistId) =>
      getDb()
        .delete(userFollowedArtists)
        .where(
          and(
            eq(userFollowedArtists.oxyUserId, oxyUserId),
            eq(userFollowedArtists.artistId, artistId)
          )
        ),
    missingTargetConstraint: 'user_followed_artists_artist_id_catalog_entities_id_fk',
  },
  savedPlaylists: {
    list: (oxyUserId) =>
      getDb()
        .select({ targetId: userSavedPlaylists.playlistId })
        .from(userSavedPlaylists)
        .where(eq(userSavedPlaylists.oxyUserId, oxyUserId))
        .orderBy(asc(userSavedPlaylists.createdAt)),
    insert: (oxyUserId, playlistId) =>
      getDb().insert(userSavedPlaylists).values({ oxyUserId, playlistId }).onConflictDoNothing(),
    remove: (oxyUserId, playlistId) =>
      getDb()
        .delete(userSavedPlaylists)
        .where(
          and(
            eq(userSavedPlaylists.oxyUserId, oxyUserId),
            eq(userSavedPlaylists.playlistId, playlistId)
          )
        ),
    missingTargetConstraint: 'user_saved_playlists_playlist_id_playlists_id_fk',
  },
};

/** One user's membership ids, oldest first. */
export async function listMembership(
  kind: MembershipKind,
  oxyUserId: string
): Promise<string[]> {
  const rows = await RELATIONS[kind].list(oxyUserId);
  return rows.map((row) => row.targetId);
}

/** What {@link addMembership} can answer. */
export type AddMembershipResult = 'added' | 'missing-target';

/**
 * Add one membership, idempotently.
 *
 * `'missing-target'` when the id names nothing — see this file's doc comment
 * for why that is a real answer here and was not one under Mongo.
 */
export async function addMembership(
  kind: MembershipKind,
  oxyUserId: string,
  targetId: string
): Promise<AddMembershipResult> {
  const relation = RELATIONS[kind];
  try {
    await relation.insert(oxyUserId, targetId);
    return 'added';
  } catch (error) {
    if (isForeignKeyViolation(error, relation.missingTargetConstraint)) {
      return 'missing-target';
    }
    throw error;
  }
}

/** Remove one membership. Removing what is not there is a successful no-op. */
export async function removeMembership(
  kind: MembershipKind,
  oxyUserId: string,
  targetId: string
): Promise<void> {
  await RELATIONS[kind].remove(oxyUserId, targetId);
}
