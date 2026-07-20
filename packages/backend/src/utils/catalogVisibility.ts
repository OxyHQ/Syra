import type { QueryFilter } from 'mongoose';
import { UserMusicPreferencesModel } from '../models/UserMusicPreferences';
import type { OxyAuthRequest } from '@oxyhq/core/server';

const AUDIUS_ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

export interface CatalogPlaybackOptions {
  allowDirectAudiusStreaming?: boolean;
}

export function isAudiusCatalogEnabled(): boolean {
  return AUDIUS_ENABLED_VALUES.has(String(process.env.AUDIUS_CATALOG_ENABLED ?? '').trim().toLowerCase());
}

function andFilter<T>(filter: QueryFilter<T>, condition: QueryFilter<T>): QueryFilter<T> {
  if (Object.keys(filter).length === 0) {
    return condition;
  }

  return { $and: [filter, condition] } as QueryFilter<T>;
}

export function visibleCatalogFilter<T>(filter: QueryFilter<T> = {}): QueryFilter<T> {
  if (isAudiusCatalogEnabled()) return filter;
  return andFilter(filter, { source: { $ne: 'audius' } } as QueryFilter<T>);
}

export function syraHostedOrDirectAllowedTrackFilter<T>(
  options: CatalogPlaybackOptions = {},
): QueryFilter<T> {
  const hlsReadyAudius: QueryFilter<T> = {
    source: 'audius',
    status: 'ready',
    hlsMasterKey: { $exists: true },
    'hls.0': { $exists: true },
  } as QueryFilter<T>;

  const alternatives: QueryFilter<T>[] = [
    { source: { $ne: 'audius' } } as QueryFilter<T>,
    hlsReadyAudius,
  ];

  if (options.allowDirectAudiusStreaming === true) {
    alternatives.push({
      source: 'audius',
      status: 'ready',
      streamUrl: { $exists: true },
    } as QueryFilter<T>);
  }

  return {
    $or: alternatives,
  } as QueryFilter<T>;
}

/**
 * `copyrightRemoved` is checked here as well as `isAvailable` so the CATALOG
 * authority agrees with the PLAYBACK authority (`isTrackPlayable` in
 * stream.controller) by construction. Artist-termination takedowns historically
 * set only `copyrightRemoved`, which left those tracks listed and searchable but
 * unplayable; keeping both conditions here also repairs already-struck tracks
 * without a backfill. Both are indexed bare fields, so this stays a leading
 * `$match` the planner can use.
 */
export function playableTrackFilter<T>(
  filter: QueryFilter<T> = {},
  options: CatalogPlaybackOptions = {},
): QueryFilter<T> {
  const available = andFilter(filter, {
    isAvailable: true,
    copyrightRemoved: { $ne: true },
  } as QueryFilter<T>);
  const visible = visibleCatalogFilter<T>(available);

  if (!isAudiusCatalogEnabled()) {
    return visible;
  }

  const playback = syraHostedOrDirectAllowedTrackFilter<T>(options);
  return andFilter(visible, playback);
}

/** Minimal shape needed to evaluate guest playability of an in-memory track. */
export interface PlayableTrackShape {
  isAvailable?: boolean;
  copyrightRemoved?: boolean;
  source?: string;
  status?: string;
  hlsMasterKey?: string;
  hls?: unknown[];
  audioSource?: unknown;
}

/**
 * In-memory equivalent of `playableTrackFilter({}, {})` — true iff the track is
 * playable for a guest viewer (no direct Audius streaming). Kept next to the
 * Mongo filter so the two stay in lockstep: a track this returns `true` for is
 * exactly a track the guest catalog query would surface.
 */
export function isGuestPlayableTrack(track: PlayableTrackShape): boolean {
  if (track.isAvailable === false || track.copyrightRemoved === true) {
    return false;
  }

  const isAudius = track.source === 'audius';

  if (!isAudiusCatalogEnabled()) {
    return !isAudius;
  }

  if (!isAudius) {
    return true;
  }

  return (
    track.status === 'ready' &&
    typeof track.hlsMasterKey === 'string' &&
    track.hlsMasterKey.length > 0 &&
    Array.isArray(track.hls) &&
    track.hls.length > 0
  );
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
 * regenerable Syra-native source: either a retained `audioSource` (uploads / CC)
 * or its own ready HLS ladder (e.g. Audius rehosted to Syra HLS). Never depends
 * on a direct-Audius provider stream.
 */
export function hasRegenerablePreviewSource(track: PlayableTrackShape): boolean {
  return Boolean(track.audioSource) || hasReadyHls(track);
}

/**
 * Truthful `previewAvailable`: the track is guest-playable AND a preview clip is
 * actually regenerable from a Syra-native source. For Audius tracks this equals
 * guest-playability (guest-playable Audius already requires ready HLS); for the
 * pathological "guest-playable but no regenerable source" case it returns false
 * so the SDK never surfaces a track whose preview would 404.
 */
export function isPreviewEligibleTrack(track: PlayableTrackShape): boolean {
  return isGuestPlayableTrack(track) && hasRegenerablePreviewSource(track);
}

export async function resolveCatalogPlaybackOptions(
  userId?: string,
): Promise<CatalogPlaybackOptions> {
  if (!userId) {
    return {};
  }

  const preferences = await UserMusicPreferencesModel.findOne({ oxyUserId: userId })
    .select({ directAudiusStreaming: 1 })
    .lean<{ directAudiusStreaming?: boolean }>();

  return {
    allowDirectAudiusStreaming: preferences?.directAudiusStreaming === true,
  };
}

export function getRequestUserId(req: Pick<OxyAuthRequest, 'user'>): string | undefined {
  const id = req.user?.id || req.user?._id;
  return typeof id === 'string' && id.trim() ? id : undefined;
}
