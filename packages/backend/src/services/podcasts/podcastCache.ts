/**
 * Cache-on-demand for external (RSS) episodes, so a popular/saved episode keeps
 * playing even if the third-party host degrades.
 *
 * With `OXY_AUDIO` on (ADR 0043 stage 4c) the copy is made BY OXY: an import by
 * URL (https, public hosts, up to 8 GiB — one over 40 MiB is fetched in the
 * background and the SDK waits), stored as Syra's own private file with Oxy's
 * audio ladder, waveform and preview, referenced as the episode's audio. One
 * URL is imported once however many episodes name it. If Oxy refuses or cannot
 * be reached, the legacy copy below is made instead: Syra fetches the enclosure
 * over an SSRF-safe channel into its bucket (at most {@link MAX_CACHE_BYTES}).
 *
 * This is the FALLBACK copy path (S3 object). The richer HLS transcode for very
 * popular episodes reuses the shared ingest pipeline (`ingestEpisode`) once the
 * source has been cached; `maybeCacheEpisode` is the popularity-gated hook the
 * audio proxy fires on origin hits.
 */

import type { IncomingMessage } from 'node:http';
import { safeFetch, SsrfRejection, UpstreamError } from '@oxy.so/core/server';
import { findEpisodeById, setEpisodeCache } from '../../db/podcasts/episodes';
import {
  getS3PodcastEpisodeCacheKey,
  importEnclosureToOxy,
  oxyAudioEnabled,
  putSourceAudio,
} from '../oxyFiles/audioStorage';
import { logger } from '../../utils/logger';
import { describeErrorSafely } from '../../utils/error';

/** Hard cap on a cached episode body (on-demand copy buffers in memory). */
export const MAX_CACHE_BYTES = 250 * 1024 * 1024; // 250 MB

/** Popularity/play threshold above which an origin hit triggers a background cache. */
const CACHE_POPULARITY_THRESHOLD = 60;
const CACHE_PLAY_THRESHOLD = 500;

const MIME_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
};

function extFor(enclosureType: string | undefined, enclosureUrl: string): string {
  if (enclosureType) {
    const normalised = enclosureType.split(';')[0]?.trim().toLowerCase();
    if (normalised && MIME_EXT[normalised]) return MIME_EXT[normalised];
  }
  const match = enclosureUrl.split('?')[0]?.match(/\.([a-z0-9]{2,4})$/i);
  return match?.[1]?.toLowerCase() ?? 'mp3';
}

async function readCapped(stream: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    stream.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        stream.destroy();
        reject(new Error(`podcastCache: enclosure exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Where an episode's enclosure was cached: an Oxy file, or a bucket object. */
export type CachedEnclosure = { store: 'oxy'; fileId: string } | { store: 'bucket'; key: string };

/**
 * Copy an episode's origin enclosure — into Oxy Files when `OXY_AUDIO` allows
 * and Oxy accepts it, into the bucket otherwise — and mark
 * `cache.status = 'cached'`. Idempotent: a no-op if already cached. Returns
 * where it is, or null when the episode is not a cacheable external episode.
 */
export async function cacheEpisode(
  episodeId: string,
  deps: { importToOxy?: typeof importEnclosureToOxy } = {},
): Promise<CachedEnclosure | null> {
  const found = await findEpisodeById(episodeId);
  if (!found) return null;
  const { episode } = found;
  if (episode.source !== 'rss' || !episode.enclosureUrl) return null;
  if (episode.audioFileId) return { store: 'oxy', fileId: episode.audioFileId };
  // `cache.s3Key` is `cache_object_key` here — renamed in `schema/podcasts.ts`
  // because `cacheS3Key` tokenizes as `cache_s_3_key` under drizzle's casing.
  if (episode.cacheStatus === 'cached' && episode.cacheObjectKey) {
    return { store: 'bucket', key: episode.cacheObjectKey };
  }

  if (oxyAudioEnabled()) {
    try {
      const stored = await (deps.importToOxy ?? importEnclosureToOxy)(
        episodeId,
        episode.enclosureUrl,
      );
      await setEpisodeCache(episodeId, { status: 'cached', cachedAt: new Date() });
      logger.info('[podcasts] episode enclosure imported into Oxy Files', {
        episodeId,
        fileId: stored.fileId,
        bytes: stored.size,
      });
      return { store: 'oxy', fileId: stored.fileId };
    } catch (err) {
      logger.warn('[podcasts] Oxy did not import the enclosure; caching it in the bucket', {
        episodeId,
        err: describeErrorSafely(err),
      });
    }
  }

  const ext = extFor(episode.enclosureType ?? undefined, episode.enclosureUrl);
  const s3Key = getS3PodcastEpisodeCacheKey(episodeId, episode.podcastId, ext);

  let result;
  try {
    result = await safeFetch(episode.enclosureUrl);
  } catch (err) {
    if (err instanceof SsrfRejection || err instanceof UpstreamError) throw err;
    throw new UpstreamError(`podcastCache: fetch failed for episode ${episodeId}`);
  }

  if (result.status < 200 || result.status >= 300) {
    result.response.destroy();
    throw new Error(`podcastCache: origin returned ${result.status} for episode ${episodeId}`);
  }

  const contentType =
    typeof result.headers['content-type'] === 'string'
      ? result.headers['content-type']
      : (episode.enclosureType ?? 'audio/mpeg');

  const buffer = await readCapped(result.response, MAX_CACHE_BYTES);
  // A mirrored RSS enclosure is Syra's copy, not anybody's upload.
  await putSourceAudio(s3Key, buffer, { contentType, owner: { kind: 'application' } });

  await setEpisodeCache(episodeId, { status: 'cached', objectKey: s3Key, cachedAt: new Date() });

  logger.info('[podcasts] episode cached to S3', { episodeId, s3Key, bytes: buffer.length });
  return { store: 'bucket', key: s3Key };
}

/**
 * Popularity-gated background cache hook. Fired (fire-and-forget) by the audio
 * proxy on an origin hit; caches the episode only once it crosses the threshold
 * and is not already cached. Errors are swallowed (best-effort optimisation).
 */
export function maybeCacheEpisode(episode: {
  id: string;
  source: 'rss' | 'syra';
  enclosureUrl: string | null;
  popularity: number;
  playCount: number;
  /** `null` when the episode has no cache state at all. */
  cacheStatus: 'none' | 'cached' | 'hls' | null;
}): void {
  if (episode.source !== 'rss' || !episode.enclosureUrl) return;
  if (episode.cacheStatus !== null && episode.cacheStatus !== 'none') return;
  const popular = episode.popularity >= CACHE_POPULARITY_THRESHOLD;
  const played = episode.playCount >= CACHE_PLAY_THRESHOLD;
  if (!popular && !played) return;

  cacheEpisode(episode.id).catch((err) =>
    logger.debug('[podcasts] background cache failed', {
      episodeId: episode.id,
      err: describeErrorSafely(err),
    }),
  );
}
