/**
 * HLS manifest building service.
 *
 * Fetches static playlists from S3 and rewrites them via the pure rewriter
 * functions. All I/O is injectable so the service is fully testable without
 * real S3 calls.
 */

import { Readable } from 'stream';
import type { ITrack } from '../../models/Track';
import { streamFromS3, getPresignedUrl } from '../s3Service';
import { rewriteMasterPlaylist, rewriteVariantPlaylist } from './playlistRewrite';

/** Presigned segment URL TTL — 6 hours, covers full playback with pause/resume. */
export const SEGMENT_URL_TTL_SEC = 21600;

// ── Dependency injection ──────────────────────────────────────────────────────

export interface ManifestDeps {
  /** Read an S3 object and return its contents as a UTF-8 string. */
  fetchText?: (s3Key: string) => Promise<string>;
  /** Generate a presigned GET URL for an S3 object. */
  presign?: (s3Key: string, ttlSec?: number) => Promise<string>;
}

async function defaultFetchText(s3Key: string): Promise<string> {
  const { stream } = await streamFromS3(s3Key);
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    (stream as Readable).on('data', (chunk: Buffer) => chunks.push(chunk));
    (stream as Readable).on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    (stream as Readable).on('error', reject);
  });
}

async function defaultPresign(s3Key: string, ttlSec: number = SEGMENT_URL_TTL_SEC): Promise<string> {
  return getPresignedUrl(s3Key, ttlSec);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the rewritten master playlist for the given track.
 *
 * Phase-5 seam: entitlement-based variant filtering goes here, before calling
 * `rewriteMasterPlaylist`. Filter `track.hls` entries to only include bitrates
 * the user's subscription tier allows, then strip the corresponding lines from
 * `rawMaster` before rewriting (or pass allowed bitrates into the rewriter).
 */
export async function buildMasterPlaylist(
  track: ITrack,
  token: string,
  baseUrl: string,
  deps?: ManifestDeps,
): Promise<string> {
  const fetchText = deps?.fetchText ?? defaultFetchText;
  const trackId = track._id.toString();

  const rawMaster = await fetchText(track.hlsMasterKey as string);

  // Phase-5 seam: filter track.hls by entitlement before rewriting master.
  return rewriteMasterPlaylist(rawMaster, { trackId, token, baseUrl });
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
