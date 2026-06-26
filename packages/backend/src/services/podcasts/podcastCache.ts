/**
 * Cache-on-demand for external (RSS) episodes. Copies an origin enclosure into
 * Syra's S3 over an SSRF-safe channel so a popular/saved episode keeps playing
 * even if the third-party host degrades, and so we can serve it from our edge.
 *
 * This is the FALLBACK copy path (S3 object). The richer HLS transcode for very
 * popular episodes reuses the shared ingest pipeline (`ingestEpisode`) once the
 * source has been cached; `maybeCacheEpisode` is the popularity-gated hook the
 * audio proxy fires on origin hits.
 */

import type { IncomingMessage } from 'node:http';
import { safeFetch, SsrfRejection, UpstreamError } from '@oxyhq/core/server';
import { EpisodeModel } from '../../models/Episode';
import { getS3PodcastEpisodeCacheKey } from '../../config/s3.config';
import { uploadToS3 } from '../s3Service';
import { logger } from '../../utils/logger';

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

/**
 * Copy an episode's origin enclosure into S3 and mark `cache.status = 'cached'`.
 * Idempotent: a no-op if already cached. Returns the resulting cache S3 key, or
 * null when the episode is not a cacheable external episode.
 */
export async function cacheEpisode(episodeId: string): Promise<string | null> {
  const episode = await EpisodeModel.findById(episodeId);
  if (!episode) return null;
  if (episode.source !== 'rss' || !episode.enclosureUrl) return null;
  if (episode.cache?.status === 'cached' && episode.cache.s3Key) return episode.cache.s3Key;

  const ext = extFor(episode.enclosureType, episode.enclosureUrl);
  const s3Key = getS3PodcastEpisodeCacheKey(episodeId, episode.podcastId.toString(), ext);

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

  const contentType = typeof result.headers['content-type'] === 'string'
    ? result.headers['content-type']
    : episode.enclosureType ?? 'audio/mpeg';

  const buffer = await readCapped(result.response, MAX_CACHE_BYTES);
  await uploadToS3(s3Key, buffer, { contentType });

  episode.cache = { status: 'cached', s3Key, cachedAt: new Date() };
  await episode.save();

  logger.info('[podcasts] episode cached to S3', { episodeId, s3Key, bytes: buffer.length });
  return s3Key;
}

/**
 * Popularity-gated background cache hook. Fired (fire-and-forget) by the audio
 * proxy on an origin hit; caches the episode only once it crosses the threshold
 * and is not already cached. Errors are swallowed (best-effort optimisation).
 */
export function maybeCacheEpisode(episode: {
  _id: { toString(): string };
  source: 'rss' | 'syra';
  enclosureUrl?: string;
  popularity?: number;
  playCount?: number;
  cache?: { status: 'none' | 'cached' | 'hls' };
}): void {
  if (episode.source !== 'rss' || !episode.enclosureUrl) return;
  if (episode.cache && episode.cache.status !== 'none') return;
  const popular = (episode.popularity ?? 0) >= CACHE_POPULARITY_THRESHOLD;
  const played = (episode.playCount ?? 0) >= CACHE_PLAY_THRESHOLD;
  if (!popular && !played) return;

  cacheEpisode(episode._id.toString()).catch((err) =>
    logger.debug('[podcasts] background cache failed', { episodeId: episode._id.toString(), err }),
  );
}
