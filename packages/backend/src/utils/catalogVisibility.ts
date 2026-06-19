import type { FilterQuery } from 'mongoose';
import { UserMusicPreferencesModel } from '../models/UserMusicPreferences';
import type { OxyAuthRequest } from '@oxyhq/core/server';

const AUDIUS_ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

export interface CatalogPlaybackOptions {
  allowDirectAudiusStreaming?: boolean;
}

export function isAudiusCatalogEnabled(): boolean {
  return AUDIUS_ENABLED_VALUES.has(String(process.env.AUDIUS_CATALOG_ENABLED ?? '').trim().toLowerCase());
}

function andFilter<T>(filter: FilterQuery<T>, condition: FilterQuery<T>): FilterQuery<T> {
  if (Object.keys(filter).length === 0) {
    return condition;
  }

  return { $and: [filter, condition] } as FilterQuery<T>;
}

export function visibleCatalogFilter<T>(filter: FilterQuery<T> = {}): FilterQuery<T> {
  if (isAudiusCatalogEnabled()) return filter;
  return andFilter(filter, { source: { $ne: 'audius' } } as FilterQuery<T>);
}

export function syraHostedOrDirectAllowedTrackFilter<T>(
  options: CatalogPlaybackOptions = {},
): FilterQuery<T> {
  const hlsReadyAudius: FilterQuery<T> = {
    source: 'audius',
    status: 'ready',
    hlsMasterKey: { $exists: true },
    'hls.0': { $exists: true },
  } as FilterQuery<T>;

  const alternatives: FilterQuery<T>[] = [
    { source: { $ne: 'audius' } } as FilterQuery<T>,
    hlsReadyAudius,
  ];

  if (options.allowDirectAudiusStreaming === true) {
    alternatives.push({
      source: 'audius',
      status: 'ready',
      streamUrl: { $exists: true },
    } as FilterQuery<T>);
  }

  return {
    $or: alternatives,
  } as FilterQuery<T>;
}

export function playableTrackFilter<T>(
  filter: FilterQuery<T> = {},
  options: CatalogPlaybackOptions = {},
): FilterQuery<T> {
  const available = andFilter(filter, { isAvailable: true } as FilterQuery<T>);
  const visible = visibleCatalogFilter<T>(available);

  if (!isAudiusCatalogEnabled()) {
    return visible;
  }

  const playback = syraHostedOrDirectAllowedTrackFilter<T>(options);
  return andFilter(visible, playback);
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
