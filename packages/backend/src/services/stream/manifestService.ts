/**
 * HLS manifest building service.
 *
 * Master playlist: built directly from `track.hls` (no S3 round-trip) and
 * filtered to bitrates ≤ the user's entitlement cap. This makes filtering
 * trivial and avoids a network read for a file we'd rewrite entirely anyway.
 *
 * Variant playlist: fetched from S3 and rewritten via the pure rewriter.
 * All I/O is injectable for testing without real S3 calls.
 */

import { Readable } from 'stream';
import type { ITrack } from '../../models/Track';
import { streamFromS3, getPresignedUrl } from '../s3Service';
import { rewriteVariantPlaylist } from './playlistRewrite';

/** Presigned segment URL TTL — 6 hours, covers full playback with pause/resume. */
export const SEGMENT_URL_TTL_SEC = 21600;

/** HLS audio codec for generated master playlists. */
export const HLS_AUDIO_CODEC = 'mp4a.40.2';

// ── Dependency injection ──────────────────────────────────────────────────────

export interface ManifestDeps {
  /** Read an S3 object and return its contents as a UTF-8 string. */
  fetchText?: (s3Key: string) => Promise<string>;
  /** Generate a presigned GET URL for an S3 object. */
  presign?: (s3Key: string, ttlSec?: number) => Promise<string>;
}

interface ManifestTextCacheEntry {
  value?: string;
  promise?: Promise<string>;
  expiresAt: number;
}

const MANIFEST_TEXT_CACHE_TTL_MS = 5 * 60 * 1000;
const MANIFEST_TEXT_CACHE_MAX_ENTRIES = 200;
const manifestTextCache = new Map<string, ManifestTextCacheEntry>();

function rememberManifestText(s3Key: string, entry: ManifestTextCacheEntry): void {
  manifestTextCache.set(s3Key, entry);
  if (manifestTextCache.size <= MANIFEST_TEXT_CACHE_MAX_ENTRIES) {
    return;
  }

  const firstKey = manifestTextCache.keys().next().value;
  if (firstKey) {
    manifestTextCache.delete(firstKey);
  }
}

function readS3Text(s3Key: string): Promise<string> {
  return streamFromS3(s3Key).then(({ stream }) => new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    (stream as Readable).on('data', (chunk: Buffer) => chunks.push(chunk));
    (stream as Readable).on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    (stream as Readable).on('error', reject);
  }));
}

async function defaultFetchText(s3Key: string): Promise<string> {
  const now = Date.now();
  const cached = manifestTextCache.get(s3Key);
  if (cached && cached.expiresAt > now) {
    if (cached.value !== undefined) return cached.value;
    if (cached.promise) return cached.promise;
  }

  const promise = readS3Text(s3Key)
    .then((value) => {
      rememberManifestText(s3Key, {
        value,
        expiresAt: Date.now() + MANIFEST_TEXT_CACHE_TTL_MS,
      });
      return value;
    })
    .catch((error) => {
      manifestTextCache.delete(s3Key);
      throw error;
    });

  rememberManifestText(s3Key, {
    promise,
    expiresAt: now + MANIFEST_TEXT_CACHE_TTL_MS,
  });

  return promise;
}

async function defaultPresign(s3Key: string, ttlSec: number = SEGMENT_URL_TTL_SEC): Promise<string> {
  return getPresignedUrl(s3Key, ttlSec);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the master playlist for the given track, filtered to renditions whose
 * bitrateKbps ≤ maxBitrateKbps.
 *
 * The master is generated directly from `track.hls` (no S3 fetch) so filtering
 * is trivial and avoids a network round-trip.
 *
 * Phase-5 seam: additional entitlement-based filtering (e.g. content tier) can
 * be applied here before the `track.hls.filter(...)` step.
 */
export async function buildMasterPlaylist(
  track: ITrack,
  token: string,
  baseUrl: string,
  maxBitrateKbps: number,
  _deps?: ManifestDeps,
): Promise<string> {
  const trackId = track._id.toString();
  const renditions = (track.hls ?? [])
    .filter((r) => r.bitrateKbps <= maxBitrateKbps)
    .sort((a, b) => a.bitrateKbps - b.bitrateKbps);

  const lines: string[] = ['#EXTM3U'];
  for (const r of renditions) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bitrateKbps * 1000},CODECS="${HLS_AUDIO_CODEC}"`);
    lines.push(`${baseUrl}/api/stream/${trackId}/v/${r.bitrateKbps}.m3u8?t=${token}`);
  }

  return lines.join('\n');
}

/**
 * Build the rewritten variant playlist for the given track and bitrate.
 *
 * Throws if `bitrateKbps` is not present in `track.hls`.
 */
export async function buildVariantPlaylist(
  track: ITrack,
  bitrateKbps: number,
  token: string,
  baseUrl: string,
  deps?: ManifestDeps,
): Promise<string> {
  const fetchText = deps?.fetchText ?? defaultFetchText;
  const doPresign = deps?.presign ?? defaultPresign;
  const trackId = track._id.toString();

  const rendition = track.hls?.find((r) => r.bitrateKbps === bitrateKbps);
  if (!rendition) {
    throw new Error(
      `No HLS rendition at ${bitrateKbps} kbps for track ${trackId}`,
    );
  }

  const rawVariant = await fetchText(rendition.manifestKey);

  // Segment key dir: e.g. "hls/artist/track/96/index.m3u8" → "hls/artist/track/96"
  const manifestDir = rendition.manifestKey.replace(/\/[^/]+$/, '');

  return rewriteVariantPlaylist(rawVariant, {
    trackId,
    token,
    baseUrl,
    presign: (segmentName) =>
      doPresign(`${manifestDir}/${segmentName}`, SEGMENT_URL_TTL_SEC),
  });
}
