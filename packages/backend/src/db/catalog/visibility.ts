/**
 * Catalog playability and playlist readability, on drizzle.
 *
 * The Postgres half of the port. `utils/catalogVisibility.ts` still holds the
 * Mongoose half and still serves every call site that has not moved yet; it is
 * DELETED — not deprecated, not re-exported — when its last caller is ported in
 * Task 10c. These are two implementations against two different databases with
 * an explicit death date, which is what makes this a migration rather than a
 * compatibility shim.
 *
 * ## The predicate
 *
 * Syra is an own-catalogue platform — every track is Syra-hosted — so a track is
 * playable iff it is available and not copyright-removed. There is no provider
 * dimension, no deployment flag and no per-user variation: the same predicate
 * holds for every viewer, authenticated or not.
 *
 * `copyrightRemoved` is checked alongside `isAvailable` so the CATALOG authority
 * agrees with the PLAYBACK authority by construction. Artist-termination
 * takedowns set only `copyrightRemoved`, which once left those tracks listed and
 * searchable but unplayable.
 *
 * ## Two artefacts, and why their agreement is now structural
 *
 * {@link playableTrackFilter} is a reusable SQL condition; {@link isPlayableTrack}
 * is an in-memory row predicate. They stay two artefacts because listing and
 * playback are still two authorities — but under Mongo they did not actually
 * agree, and the port is what fixes that.
 *
 * Measured on the Mongo pair before the port: the filter required
 * `isAvailable: true`, which a document with the key ABSENT does not match,
 * while the in-memory predicate accepted `isAvailable !== false`, which it does.
 * Two of the nine `{true, false, absent}²` shapes disagreed. The second
 * predicate, `isTrackPlayable` in `stream.controller.ts`, used
 * `!copyrightRemoved` against this file's `copyrightRemoved !== true`, which
 * diverge on a truthy non-boolean.
 *
 * Both divergences are gone here, and not by discipline: `tracks.is_available`
 * and `tracks.copyright_removed` are `NOT NULL` booleans, so "absent" and
 * "truthy non-boolean" are unrepresentable. The comparisons below are written
 * `=== true` / `=== false` rather than `!x` so the TypeScript predicate is the
 * literal mirror of the SQL — and so a value that somehow is not a boolean
 * fails closed in both, exactly as `eq()` would.
 *
 * `__tests__/visibility.agreement.test.ts` proves the agreement against real
 * rows rather than asserting it in this comment.
 */

import { and, eq, type SQL } from 'drizzle-orm';
import { PlaylistVisibility } from '@syra/shared-types';
import { tracks } from '../schema/catalog';

/**
 * The condition every catalog read of `tracks` composes first.
 *
 * Takes no arguments and returns a bare condition: drizzle composes with
 * `and()`, so there is no counterpart to the Mongo helper's filter parameter
 * (nor to `andMongoFilters`, which existed only because spreading two filter
 * objects could clobber an existing `$or`).
 *
 *     db.select().from(tracks).where(and(playableTrackFilter(), eq(tracks.albumId, id)))
 *
 * Both columns are `NOT NULL`, so these are plain equality tests, and
 * `schema/catalog.ts` folds this exact predicate into five partial indexes —
 * every one of them is usable only by a query that carries it.
 */
export function playableTrackFilter(): SQL {
  // `and()` is typed as possibly-undefined for the zero-argument case; with two
  // conditions it always returns one, and the cast keeps every call site from
  // having to narrow a value that cannot be undefined.
  return and(eq(tracks.isAvailable, true), eq(tracks.copyrightRemoved, false)) as SQL;
}

/** The columns {@link isPlayableTrack} reads. Both are `NOT NULL` in Postgres. */
export interface PlayableTrackRow {
  readonly isAvailable: boolean;
  readonly copyrightRemoved: boolean;
}

/**
 * In-memory equivalent of {@link playableTrackFilter}: a row this returns `true`
 * for is exactly a row the catalog query would surface.
 */
export function isPlayableTrack(track: PlayableTrackRow): boolean {
  return track.isAvailable === true && track.copyrightRemoved === false;
}

/** The columns {@link isPreviewEligibleTrack} reads, beyond playability. */
export interface PreviewEligibleTrackRow extends PlayableTrackRow {
  readonly status: string;
  readonly hlsMasterKey: string | null;
  /**
   * How many rows this track has in `track_hls_renditions`.
   *
   * The Mongo shape was an embedded `hls[]` array and the check was
   * `hls.length > 0`; Task 4 moved the ladder to a child table, so the caller
   * supplies the count rather than the array. Nothing here needs a rendition's
   * contents — only whether the ladder exists.
   */
  readonly hlsRenditionCount: number;
  /** `audioSource.url` flattened; null while a track is still processing. */
  readonly audioSourceUrl: string | null;
}

/** True iff the track has Syra-hosted, ready, encrypted HLS we can clip from. */
function hasReadyHls(track: PreviewEligibleTrackRow): boolean {
  return (
    track.status === 'ready' &&
    typeof track.hlsMasterKey === 'string' &&
    track.hlsMasterKey.length > 0 &&
    track.hlsRenditionCount > 0
  );
}

/**
 * True iff a 30s preview can actually be generated for this track — it has a
 * regenerable source: either a retained original file (uploads / CC) or its own
 * ready HLS ladder.
 *
 * Not exported: `hasReadyHls` and its sibling `hasRegenerablePreviewSource` were
 * both exported from the Mongo module and referenced nowhere outside it, so the
 * two are folded back in here rather than carried over as dead surface.
 */
function hasRegenerablePreviewSource(track: PreviewEligibleTrackRow): boolean {
  return (track.audioSourceUrl !== null && track.audioSourceUrl.length > 0) || hasReadyHls(track);
}

/**
 * Truthful `previewAvailable`: the track is playable AND a preview clip is
 * actually regenerable, so the SDK never surfaces a track whose preview would
 * 404.
 */
export function isPreviewEligibleTrack(track: PreviewEligibleTrackRow): boolean {
  return isPlayableTrack(track) && hasRegenerablePreviewSource(track);
}

/** What deciding who may read a playlist needs. */
export interface ViewablePlaylistRow {
  readonly visibility: string;
  readonly ownerOxyUserId: string;
  /**
   * `playlist_collaborators.oxy_user_id` for this playlist, of any role.
   *
   * A separate table now rather than an embedded array, so a caller that has
   * not loaded them passes `undefined` — which is treated as "no collaborators",
   * the same fail-closed answer the Mongo version gave for an absent field.
   */
  readonly collaboratorOxyUserIds?: readonly string[];
}

/**
 * Playlist readability, in one place.
 *
 * Unlike track playability, playlists DO vary per viewer: a public playlist is
 * readable by anyone, a non-public one only by its owner or a collaborator of
 * any role. Kept beside the track predicate so every surface that exposes a
 * playlist — the playlists API, radio seeds — asks the same question, and a
 * change to the rule cannot land in one place and miss the other.
 */
export function canViewPlaylist(playlist: ViewablePlaylistRow, userId?: string): boolean {
  if (playlist.visibility === PlaylistVisibility.PUBLIC) return true;
  if (!userId) return false;
  if (playlist.ownerOxyUserId === userId) return true;
  return playlist.collaboratorOxyUserIds?.includes(userId) === true;
}
