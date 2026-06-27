import { S3Client } from '@aws-sdk/client-s3';
import { logger } from '../utils/logger';

/**
 * S3 Client Configuration — AWS only (us-west-2, Fargate/ECS).
 *
 * Credential chain:
 *   1. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY env vars (local dev, CI)
 *   2. ECS task IAM role (production — credentials left undefined so the SDK
 *      falls back to the standard credential provider chain automatically)
 *
 * Local-dev escape hatch:
 *   Set AWS_ENDPOINT_URL to point at LocalStack or MinIO — forcePathStyle is
 *   enabled automatically in that case.
 */

const DEFAULT_AWS_REGION = 'us-west-2';
const AWS_REGION = process.env.AWS_REGION || DEFAULT_AWS_REGION;
const AWS_ENDPOINT_URL = process.env.AWS_ENDPOINT_URL;

const ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

// When no explicit credentials are present the SDK uses the ECS task role —
// do NOT pass an empty credentials object (that would override the role).
const credentials =
  ACCESS_KEY_ID && SECRET_ACCESS_KEY
    ? { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY }
    : undefined;

if (!credentials) {
  logger.info('[S3Config] No explicit S3 credentials — relying on ECS task IAM role');
}

export const s3Client = new S3Client({
  region: AWS_REGION,
  credentials,
  ...(AWS_ENDPOINT_URL
    ? { endpoint: AWS_ENDPOINT_URL, forcePathStyle: true }
    : {}),
});

// Read bucket name from environment variable
// Support both AWS_S3_BUCKET_NAME (documented) and AWS_S3_BUCKET (backwards compatibility)
export const S3_BUCKET_NAME =
  process.env.AWS_S3_BUCKET_NAME || process.env.AWS_S3_BUCKET || 'syra-audio';
export const S3_AUDIO_PREFIX = process.env.S3_AUDIO_PREFIX || 'audio';
export const S3_IMAGE_PREFIX = process.env.S3_IMAGE_PREFIX || 'images';

// Export region and endpoint for error messages
export const S3_REGION = AWS_REGION;
export const S3_ENDPOINT = AWS_ENDPOINT_URL;

logger.info('[S3Config] S3 configuration:', {
  bucket: S3_BUCKET_NAME,
  region: AWS_REGION,
  endpoint: AWS_ENDPOINT_URL ?? 'default (AWS)',
  audioPrefix: S3_AUDIO_PREFIX,
  imagePrefix: S3_IMAGE_PREFIX,
  credentialsConfigured: !!credentials,
  credentialSource: credentials ? 'AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY' : 'ECS task IAM role',
});

/**
 * Get S3 key for an audio file
 * Format: audio/{artistId}/{albumId}/{trackId}.{format}
 */
export function getS3AudioKey(
  trackId: string,
  artistId: string,
  albumId: string | undefined,
  format: string,
): string {
  const extension = format.startsWith('.') ? format : `.${format}`;
  if (albumId) {
    return `${S3_AUDIO_PREFIX}/${artistId}/${albumId}/${trackId}${extension}`;
  }
  return `${S3_AUDIO_PREFIX}/${artistId}/${trackId}${extension}`;
}

export const S3_HLS_PREFIX = process.env.S3_HLS_PREFIX || 'hls';

/**
 * Get S3 key for an HLS file (playlist or segment).
 * Format: hls/{artistId}/{trackId}/{relPath}
 * Normalises backslashes and strips leading slashes from relPath.
 */
export function getS3HlsKey(artistId: string, trackId: string, relPath: string): string {
  const normalised = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `${S3_HLS_PREFIX}/${artistId}/${trackId}/${normalised}`;
}

export const S3_PODCAST_PREFIX = process.env.S3_PODCAST_PREFIX || 'podcasts';

/**
 * Get the S3 key for a Syra-hosted podcast episode's SOURCE audio (creator
 * upload). Format: podcasts/audio/{podcastId}/{episodeId}.{format}
 */
export function getS3PodcastEpisodeAudioKey(
  episodeId: string,
  podcastId: string,
  format: string,
): string {
  const extension = format.startsWith('.') ? format : `.${format}`;
  return `${S3_PODCAST_PREFIX}/audio/${podcastId}/${episodeId}${extension}`;
}

/**
 * Get the S3 key for a CACHED external (RSS) episode enclosure copied into Syra
 * storage. Format: podcasts/cache/{podcastId}/{episodeId}.{ext}
 */
export function getS3PodcastEpisodeCacheKey(
  episodeId: string,
  podcastId: string,
  ext: string,
): string {
  const extension = ext.startsWith('.') ? ext : `.${ext}`;
  return `${S3_PODCAST_PREFIX}/cache/${podcastId}/${episodeId}${extension}`;
}

export function getS3ImageKey(imageId: string, filename: string): string {
  const safeFilename = filename
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'image';
  return `${S3_IMAGE_PREFIX}/${imageId}/${safeFilename}`;
}

export const S3_PREVIEW_PREFIX = process.env.S3_PREVIEW_PREFIX || 'previews';

/**
 * Get the S3 key for a public 30s preview clip.
 * Format: previews/{trackId}/{startSec}.mp3
 *
 * These objects are served by the public, unauthenticated preview endpoint and
 * are safe to cache at the edge — the key is fully derived from the track id and
 * the (clamped, integer) start offset.
 */
export function getS3PreviewKey(trackId: string, startSec: number): string {
  const safeStart = Math.max(0, Math.trunc(startSec));
  return `${S3_PREVIEW_PREFIX}/${trackId}/${safeStart}.mp3`;
}
