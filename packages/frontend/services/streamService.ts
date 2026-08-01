import type { PlayableRef } from '@syra/shared-types';
import { api } from '@/utils/api';
import { createScopedLogger } from '@/utils/logger';

const logger = createScopedLogger('StreamService');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StreamResolution {
  url: string;
  type: 'hls';
  expiresAt: string | null;
}

interface StreamCacheEntry {
  resolution?: StreamResolution;
  promise?: Promise<StreamResolution>;
  expiresAtMs: number;
}

const STREAM_CACHE_MAX_ENTRIES = 80;
const STREAM_CACHE_SAFETY_WINDOW_MS = 60 * 1000;
const STREAM_CACHE_FALLBACK_TTL_MS = 10 * 60 * 1000;

const streamCache = new Map<string, StreamCacheEntry>();

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  if (!error || typeof error !== 'object') {
    return 'Unknown error';
  }

  const record = error as Record<string, unknown>;
  const response = record.response;
  if (response && typeof response === 'object') {
    const responseRecord = response as Record<string, unknown>;
    const data = responseRecord.data;
    if (data && typeof data === 'object') {
      const dataRecord = data as Record<string, unknown>;
      if (typeof dataRecord.message === 'string' && dataRecord.message.trim()) return dataRecord.message;
      if (typeof dataRecord.error === 'string' && dataRecord.error.trim()) return dataRecord.error;
    }
    if (typeof responseRecord.status === 'number') {
      return `HTTP ${responseRecord.status}`;
    }
  }

  if (typeof record.message === 'string' && record.message.trim()) return record.message;
  if (typeof record.error === 'string' && record.error.trim()) return record.error;
  if (typeof record.status === 'number') return `HTTP ${record.status}`;

  return 'Unknown error';
}

function getResolutionExpiryMs(resolution: StreamResolution): number {
  if (!resolution.expiresAt) {
    return Date.now() + STREAM_CACHE_FALLBACK_TTL_MS;
  }

  const parsed = Date.parse(resolution.expiresAt);
  return Number.isFinite(parsed) ? parsed : Date.now() + STREAM_CACHE_FALLBACK_TTL_MS;
}

function isFresh(entry: StreamCacheEntry): boolean {
  return entry.expiresAtMs > Date.now() + STREAM_CACHE_SAFETY_WINDOW_MS;
}

function remember(trackId: string, entry: StreamCacheEntry): void {
  streamCache.set(trackId, entry);
  if (streamCache.size <= STREAM_CACHE_MAX_ENTRIES) {
    return;
  }

  const firstKey = streamCache.keys().next().value;
  if (firstKey) {
    streamCache.delete(firstKey);
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Resolve a tokenized HLS/provider stream from a backend resolver endpoint,
 * memoizing the result (and the in-flight promise) until shortly before expiry.
 *
 * `cacheKey` namespaces the entry so track ids and episode ids never collide in
 * the shared cache.
 */
async function resolveFromEndpoint(
  cacheKey: string,
  endpoint: string,
  label: string,
): Promise<StreamResolution> {
  const cached = streamCache.get(cacheKey);
  if (cached?.resolution && isFresh(cached)) {
    return cached.resolution;
  }
  if (cached?.promise && isFresh(cached)) {
    return cached.promise;
  }

  const promise = api.get<StreamResolution>(endpoint)
    .then((res) => {
      const resolution = res.data;
      remember(cacheKey, {
        resolution,
        expiresAtMs: getResolutionExpiryMs(resolution),
      });
      return resolution;
    })
    .catch((error) => {
      streamCache.delete(cacheKey);
      throw new Error(
        `Failed to resolve stream for ${label}: ${getErrorMessage(error)}`,
      );
    });

  remember(cacheKey, {
    promise,
    expiresAtMs: Date.now() + STREAM_CACHE_FALLBACK_TTL_MS,
  });
  return promise;
}

/**
 * Resolve the stream URL for a track from the backend.
 *
 * Calls `GET /api/stream/:trackId` (bearer-authenticated) which returns the
 * resolved URL along with its type and optional expiry.
 *
 * Resolutions are always `type: 'hls'` — an API-served tokenized HLS master
 * playlist.
 *
 * @throws Error on any network or API error, with a descriptive message
 *   including the trackId and the original error message.
 */
export function resolveStream(trackId: string): Promise<StreamResolution> {
  return resolveFromEndpoint(trackId, `/stream/${trackId}`, trackId);
}

/**
 * Resolve the tokenized HLS stream for a Syra-hosted episode.
 *
 * Calls `GET /api/podcasts/episodes/:id/stream` (bearer-authenticated) which
 * mints a session token and returns the master playlist URL (`type: 'hls'`).
 * External (rss) episodes are NOT resolved here — they play from the public
 * progressive `/audio` proxy URL built directly in the player.
 */
export function resolveEpisodeStream(episodeId: string): Promise<StreamResolution> {
  return resolveFromEndpoint(
    `episode:${episodeId}`,
    `/podcasts/episodes/${episodeId}/stream`,
    `episode ${episodeId}`,
  );
}

/**
 * Resolve the tokenized HLS stream for a file in the caller's own locker.
 *
 * Calls `GET /api/uploads/:id/stream`, whose ownership check is part of the
 * query that loads the document — a stranger's upload id answers 404, the same
 * as one that does not exist. Everything else matches catalog playback: the same
 * LRU, the same 60s safety window, the same `type: 'hls'` resolution the player
 * already knows how to attach.
 *
 * The cache key is namespaced because an upload id and a track id are ids in
 * two different collections; sharing one keyspace would let a locker resolution
 * answer a catalog request the moment two ids ever collided.
 */
export function resolveUploadStream(uploadId: string): Promise<StreamResolution> {
  return resolveFromEndpoint(
    `upload:${uploadId}`,
    `/uploads/${uploadId}/stream`,
    `upload ${uploadId}`,
  );
}

/**
 * Warm the resolution cache for items the listener has not asked for yet.
 *
 * Takes refs rather than ids because the two kinds resolve through different
 * endpoints, and a locker id sent to the catalog resolver would be a 404 that
 * looks exactly like an entitlement failure.
 */
export function prefetchStreams(refs: PlayableRef[]): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}`;
    if (!ref.id || seen.has(key)) {
      continue;
    }
    seen.add(key);

    // Prefetch is opportunistic — these items have not been asked for yet, so a
    // failure must not reach the listener; the real play attempt resolves again
    // and reports its own. Logged so it is never entirely invisible: a signed-out
    // listener's 401s show up here first.
    const resolving = ref.kind === 'upload' ? resolveUploadStream(ref.id) : resolveStream(ref.id);
    void resolving.catch((error) => {
      logger.debug('Stream prefetch failed', { ref, error });
    });
  }
}

export function clearStreamResolutionCache(): void {
  streamCache.clear();
}
