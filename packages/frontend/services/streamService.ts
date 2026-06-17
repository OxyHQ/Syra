import { api } from '@/utils/api';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StreamResolution {
  url: string;
  type: 'hls' | 'audius';
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
 * Resolve the stream URL for a track from the backend.
 *
 * Calls `GET /api/stream/:trackId` (bearer-authenticated) which returns the
 * resolved URL along with its type and optional expiry.
 *
 * - `type: 'hls'`    — API-served tokenized HLS master playlist.
 * - `type: 'audius'` — Direct Audius network stream URL.
 *
 * @throws Error on any network or API error, with a descriptive message
 *   including the trackId and the original error message.
 */
export async function resolveStream(trackId: string): Promise<StreamResolution> {
  const cached = streamCache.get(trackId);
  if (cached?.resolution && isFresh(cached)) {
    return cached.resolution;
  }
  if (cached?.promise && isFresh(cached)) {
    return cached.promise;
  }

  const promise = api.get<StreamResolution>(`/stream/${trackId}`)
    .then((res) => {
      const resolution = res.data;
      remember(trackId, {
        resolution,
        expiresAtMs: getResolutionExpiryMs(resolution),
      });
      return resolution;
    })
    .catch((error) => {
      streamCache.delete(trackId);
      throw new Error(
        `Failed to resolve stream for ${trackId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    });

  try {
    remember(trackId, {
      promise,
      expiresAtMs: Date.now() + STREAM_CACHE_FALLBACK_TTL_MS,
    });
    return await promise;
  } catch (error) {
    throw error;
  }
}

export function prefetchStreams(trackIds: string[]): void {
  const uniqueTrackIds = [...new Set(trackIds.filter(Boolean))];
  for (const trackId of uniqueTrackIds) {
    void resolveStream(trackId).catch(() => {
      // Prefetch is opportunistic; playback will surface a real error if needed.
    });
  }
}

export function clearStreamResolutionCache(): void {
  streamCache.clear();
}
