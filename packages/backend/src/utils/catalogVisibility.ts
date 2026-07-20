import type { QueryFilter } from 'mongoose';
import type { OxyAuthRequest } from '@oxyhq/core/server';

function andFilter<T>(filter: QueryFilter<T>, condition: QueryFilter<T>): QueryFilter<T> {
  if (Object.keys(filter).length === 0) {
    return condition;
  }

  return { $and: [filter, condition] } as QueryFilter<T>;
}

/**
 * Catalog playability, in one place.
 *
 * Syra is an own-catalogue platform — every track is Syra-hosted — so a track is
 * playable iff it is available and not copyright-removed. There is no provider
 * dimension, no deployment flag and no per-user variation: the same predicate
 * holds for every viewer, authenticated or not.
 *
 * `copyrightRemoved` is checked alongside `isAvailable` so the CATALOG authority
 * agrees with the PLAYBACK authority (`isTrackPlayable` in stream.controller) by
 * construction. Artist-termination takedowns set only `copyrightRemoved`, which
 * left those tracks listed and searchable but unplayable; checking both here also
 * repairs already-struck tracks without a backfill. Both are indexed bare fields,
 * so this stays a leading `$match` the planner can use.
 */
export function playableTrackFilter<T>(filter: QueryFilter<T> = {}): QueryFilter<T> {
  return andFilter(filter, {
    isAvailable: true,
    copyrightRemoved: { $ne: true },
  } as QueryFilter<T>);
}

/** Minimal shape needed to evaluate playability of an in-memory track. */
export interface PlayableTrackShape {
  isAvailable?: boolean;
  copyrightRemoved?: boolean;
  status?: string;
  hlsMasterKey?: string;
  hls?: unknown[];
  audioSource?: unknown;
}

/**
 * In-memory equivalent of `playableTrackFilter()`. Kept next to the Mongo filter
 * so the two stay in lockstep: a track this returns `true` for is exactly a track
 * the catalog query would surface.
 */
export function isPlayableTrack(track: PlayableTrackShape): boolean {
  return track.isAvailable !== false && track.copyrightRemoved !== true;
}

/** True iff the track has Syra-hosted, ready, encrypted HLS we can clip from. */
export function hasReadyHls(track: PlayableTrackShape): boolean {
  return (
    track.status === 'ready' &&
    typeof track.hlsMasterKey === 'string' &&
    track.hlsMasterKey.length > 0 &&
    Array.isArray(track.hls) &&
    track.hls.length > 0
  );
}

/**
 * True iff a 30s preview can actually be generated for this track — it has a
 * regenerable source: either a retained `audioSource` (uploads / CC) or its own
 * ready HLS ladder.
 */
export function hasRegenerablePreviewSource(track: PlayableTrackShape): boolean {
  return Boolean(track.audioSource) || hasReadyHls(track);
}

/**
 * Truthful `previewAvailable`: the track is playable AND a preview clip is
 * actually regenerable, so the SDK never surfaces a track whose preview would 404.
 */
export function isPreviewEligibleTrack(track: PlayableTrackShape): boolean {
  return isPlayableTrack(track) && hasRegenerablePreviewSource(track);
}

export function getRequestUserId(req: Pick<OxyAuthRequest, 'user'>): string | undefined {
  const id = req.user?.id || req.user?._id;
  return typeof id === 'string' && id.trim() ? id : undefined;
}
