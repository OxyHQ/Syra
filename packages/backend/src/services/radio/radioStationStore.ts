import { RadioSeedType, radioSeedTypeSchema } from '@syra/shared-types';
import { getRedisClient } from '../../utils/redis';
import { logger } from '../../utils/logger';

const RADIO_STATION_KEY_PREFIX = 'radio:station:';

/** Stations expire a day after their last read or write. */
export const RADIO_STATION_TTL_SECONDS = 24 * 60 * 60;

/** Hard cap on the served-track history kept per station, oldest evicted first. */
export const MAX_SERVED_TRACK_IDS = 1000;

/** How many of the most recently served tracks the next page treats as "just heard". */
export const FRONTIER_SIZE = 8;

/** How many recently served pages are memoised so a client retry replays instead of burning catalog. */
export const RECENT_PAGE_MEMORY = 3;

/** Current station format. Bump only alongside a breaking shape change. */
export const RADIO_STATION_VERSION = 1;

/** One page the station has already handed out, kept so a retry is idempotent. */
export interface RadioServedPage {
  page: number;
  trackIds: string[];
}

/**
 * Everything the generator needs to produce the *next* page of a station
 * without re-deriving history from the listener's play events.
 */
export interface RadioStationState {
  v: 1;
  seedType: RadioSeedType;
  seedId: string;
  /** Re-derived from the request on every call — never read from a client cursor. */
  ownerKey: string;
  createdAt: number;
  page: number;
  /** FIFO, capped at {@link MAX_SERVED_TRACK_IDS}. */
  servedTrackIds: string[];
  /** The last {@link FRONTIER_SIZE} served track ids, most recent last. */
  frontierTrackIds: string[];
  /** The last {@link RECENT_PAGE_MEMORY} served pages. */
  recentPages: RadioServedPage[];
  /** Tracks served to this station while the listener was a guest. */
  guestServedCount: number;
  /** When the generator ran out of fresh candidates and looped the pool. */
  wrappedAt?: number;
}

export interface RadioStationIdentity {
  seedType: RadioSeedType;
  seedId: string;
  ownerKey: string;
}

function getStationKey({ ownerKey, seedType, seedId }: RadioStationIdentity): string {
  return `${RADIO_STATION_KEY_PREFIX}${ownerKey}:${seedType}:${seedId}`;
}

/**
 * A brand-new, empty station. Also the value returned when Redis is
 * unavailable or holds an unreadable entry — see {@link readRadioStation}.
 */
export function createRadioStationState(identity: RadioStationIdentity): RadioStationState {
  return {
    v: RADIO_STATION_VERSION,
    seedType: identity.seedType,
    seedId: identity.seedId,
    ownerKey: identity.ownerKey,
    createdAt: Date.now(),
    page: 0,
    servedTrackIds: [],
    frontierTrackIds: [],
    recentPages: [],
    guestServedCount: 0,
  };
}

function parseStationState(
  data: string,
  identity: RadioStationIdentity
): RadioStationState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    logger.warn('[RadioStationStore] Discarding unparseable station entry', error);
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  if (candidate.v !== RADIO_STATION_VERSION) {
    return null;
  }

  const seedType = radioSeedTypeSchema.safeParse(candidate.seedType);
  if (!seedType.success) {
    return null;
  }

  if (typeof candidate.seedId !== 'string' || typeof candidate.ownerKey !== 'string') {
    return null;
  }

  // The key already scopes the entry to this owner and seed; a mismatch means a
  // key collision or a hand-edited entry, so start fresh rather than serve it.
  if (
    candidate.ownerKey !== identity.ownerKey ||
    candidate.seedId !== identity.seedId ||
    seedType.data !== identity.seedType
  ) {
    return null;
  }

  const stringArray = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
      ? (value as string[])
      : null;

  const servedTrackIds = stringArray(candidate.servedTrackIds);
  const frontierTrackIds = stringArray(candidate.frontierTrackIds);
  if (!servedTrackIds || !frontierTrackIds) {
    return null;
  }

  if (!Array.isArray(candidate.recentPages)) {
    return null;
  }

  const recentPages: RadioServedPage[] = [];
  for (const entry of candidate.recentPages) {
    if (typeof entry !== 'object' || entry === null) {
      return null;
    }
    const page = (entry as Record<string, unknown>).page;
    const trackIds = stringArray((entry as Record<string, unknown>).trackIds);
    if (typeof page !== 'number' || !Number.isInteger(page) || !trackIds) {
      return null;
    }
    recentPages.push({ page, trackIds });
  }

  const page = candidate.page;
  const createdAt = candidate.createdAt;
  const guestServedCount = candidate.guestServedCount;
  if (
    typeof page !== 'number' ||
    !Number.isInteger(page) ||
    typeof createdAt !== 'number' ||
    typeof guestServedCount !== 'number'
  ) {
    return null;
  }

  const wrappedAt = candidate.wrappedAt;

  return {
    v: RADIO_STATION_VERSION,
    seedType: seedType.data,
    seedId: candidate.seedId,
    ownerKey: candidate.ownerKey,
    createdAt,
    page,
    servedTrackIds,
    frontierTrackIds,
    recentPages,
    guestServedCount,
    ...(typeof wrappedAt === 'number' ? { wrappedAt } : {}),
  };
}

/**
 * Load a station, refreshing its TTL.
 *
 * Never returns `null` and never throws. When Redis is unavailable — or the
 * stored entry is missing, stale-versioned or corrupt — this hands back a fresh
 * stateless station so the caller still programmes and serves tracks. That is a
 * designed property, not a fallback bug: radio degrades into "may repeat
 * tracks", never into a 503. The listener keeps hearing music.
 */
export async function readRadioStation(
  identity: RadioStationIdentity
): Promise<RadioStationState> {
  try {
    const redis = getRedisClient();
    if (!redis.isReady) {
      logger.warn('[RadioStationStore] Redis not ready, serving a stateless station');
      return createRadioStationState(identity);
    }

    const key = getStationKey(identity);
    const data = await redis.get(key);
    if (!data) {
      return createRadioStationState(identity);
    }

    const state = parseStationState(data, identity);
    if (!state) {
      return createRadioStationState(identity);
    }

    // Refresh the TTL so an actively listened station never expires mid-session.
    await redis.expire(key, RADIO_STATION_TTL_SECONDS);
    return state;
  } catch (error) {
    logger.error('[RadioStationStore] Error reading station:', error);
    return createRadioStationState(identity);
  }
}

/**
 * Persist a station. Returns whether it was actually stored — a `false` means
 * the next page will be programmed statelessly, which the caller tolerates.
 */
export async function writeRadioStation(state: RadioStationState): Promise<boolean> {
  try {
    const redis = getRedisClient();
    if (!redis.isReady) {
      logger.warn('[RadioStationStore] Redis not ready, cannot persist station');
      return false;
    }

    const key = getStationKey(state);
    await redis.setEx(key, RADIO_STATION_TTL_SECONDS, JSON.stringify(state));
    return true;
  } catch (error) {
    logger.error('[RadioStationStore] Error writing station:', error);
    return false;
  }
}

/** Drop a station so the next request rebuilds it from scratch. */
export async function clearRadioStation(identity: RadioStationIdentity): Promise<boolean> {
  try {
    const redis = getRedisClient();
    if (!redis.isReady) {
      logger.warn('[RadioStationStore] Redis not ready, cannot clear station');
      return false;
    }

    await redis.del(getStationKey(identity));
    return true;
  } catch (error) {
    logger.error('[RadioStationStore] Error clearing station:', error);
    return false;
  }
}

/**
 * Fold a freshly served page into the station, applying every retention cap.
 *
 * Pure — it returns a new state rather than mutating, so the caps are unit
 * testable without Redis and a failed write cannot leave a half-updated object.
 */
export function recordServedPage(
  state: RadioStationState,
  page: number,
  trackIds: string[],
  options: { guest: boolean; wrapped: boolean }
): RadioStationState {
  const servedTrackIds = [...state.servedTrackIds, ...trackIds];
  const overflow = servedTrackIds.length - MAX_SERVED_TRACK_IDS;
  if (overflow > 0) {
    servedTrackIds.splice(0, overflow);
  }

  const recentPages = [
    ...state.recentPages.filter((entry) => entry.page !== page),
    { page, trackIds: [...trackIds] },
  ].slice(-RECENT_PAGE_MEMORY);

  return {
    ...state,
    page: Math.max(state.page, page + 1),
    servedTrackIds,
    frontierTrackIds: servedTrackIds.slice(-FRONTIER_SIZE),
    recentPages,
    guestServedCount: state.guestServedCount + (options.guest ? trackIds.length : 0),
    ...(options.wrapped && state.wrappedAt === undefined ? { wrappedAt: Date.now() } : {}),
  };
}

/** The memoised page for an idempotent client retry, or `null` if it has aged out. */
export function findServedPage(state: RadioStationState, page: number): RadioServedPage | null {
  return state.recentPages.find((entry) => entry.page === page) ?? null;
}
