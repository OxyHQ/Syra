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

/**
 * Key space for listener uploads — the private locker.
 *
 * Deliberately a top-level prefix of its own rather than a corner of the
 * catalog's `audio/`. Catalog audio is addressed by artist and album because that
 * is what it belongs to; a locker file belongs to a PERSON, and may have no
 * artist at all (an upload with no artist is a valid private upload). Reusing the
 * artist helpers would mean fabricating a placeholder artist id, which scatters
 * locker objects through the catalog's key space and makes them indistinguishable
 * from catalog audio.
 *
 * Keeping them apart is what lets a bucket lifecycle rule, a bulk deletion or an
 * audit operate on the locker without touching the catalog — and it is what makes
 * the retention sweeper's prefix delete safe, since a locker prefix contains
 * nothing else.
 *
 * Nothing under this prefix is ever served directly: playback goes through
 * `GET /api/uploads/:id/stream`, which checks ownership first, and the manifests
 * and segments beneath it are tokenized exactly as `stream.controller` does.
 */
export const S3_UPLOADS_PREFIX = process.env.S3_UPLOADS_PREFIX || 'uploads';

/**
 * The SOURCE audio of a locker upload.
 * Format: uploads/{ownerOxyUserId}/{uploadId}.{format}
 */
export function getS3LockerAudioKey(
  ownerOxyUserId: string,
  uploadId: string,
  format: string,
): string {
  const extension = format.startsWith('.') ? format : `.${format}`;
  return `${S3_UPLOADS_PREFIX}/${ownerOxyUserId}/${uploadId}${extension}`;
}

export const S3_HLS_PREFIX = process.env.S3_HLS_PREFIX || 'hls';

/**
 * An encrypted-HLS file (playlist or segment) of a locker upload.
 * Format: hls/uploads/{ownerOxyUserId}/{uploadId}/{relPath}
 *
 * The upload id is a whole PATH SEGMENT, and that is load-bearing rather than
 * cosmetic: the copyright purge and the retention sweeper both delete this
 * directory as a PREFIX, and `compliance/takedown.ts` refuses to sweep a prefix
 * that does not contain the upload's own id as a segment. Flatten this layout and
 * the delete silently degrades to "recorded keys only", leaving every segment in
 * the bucket — no error, no orphan report, just cost.
 */
export function getS3LockerHlsKey(
  ownerOxyUserId: string,
  uploadId: string,
  relPath: string,
): string {
  const normalised = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `${S3_HLS_PREFIX}/${S3_UPLOADS_PREFIX}/${ownerOxyUserId}/${uploadId}/${normalised}`;
}

/**
 * The directory every HLS object of one locker upload lives under — what a
 * takedown or an expiry sweep deletes as a prefix. Trailing slash included, so it
 * can never match a sibling id that merely starts with the same characters.
 */
export function getS3LockerHlsPrefix(ownerOxyUserId: string, uploadId: string): string {
  return `${S3_HLS_PREFIX}/${S3_UPLOADS_PREFIX}/${ownerOxyUserId}/${uploadId}/`;
}

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

/**
 * The directory every HLS object of ONE Syra-hosted episode lives under — what a
 * creator's episode delete sweeps as a prefix.
 *
 * Expressed as `getS3HlsKey(podcastId, episodeId, '')` rather than by respelling
 * `hls/{podcastId}/{episodeId}/` here, and that is the whole point: a prefix
 * composed from a REMEMBERED convention sweeps nothing on the day ingest changes
 * the layout, and it does so silently, because deleting zero objects raises no
 * error. Deriving it from the key builder `ingestEpisode` actually writes with
 * means the two cannot disagree — there is only one spelling of the layout.
 *
 * The empty `relPath` is what leaves the trailing slash, so the prefix can never
 * match a sibling episode whose id merely starts with the same characters.
 */
export function getS3PodcastEpisodeHlsPrefix(podcastId: string, episodeId: string): string {
  return getS3HlsKey(podcastId, episodeId, '');
}

/**
 * Every directory a show's stored objects live under — the three trees a show
 * delete sweeps once its episodes have been purged individually, to catch
 * objects whose episode row no longer records their key.
 *
 * Each is scoped by the show's own id as a whole path segment with a trailing
 * slash. `hls/{podcastId}/` shares its namespace with the catalogue's
 * `hls/{artistId}/` — the two id spaces are distinct tables but one S3 tree — so
 * this is safe only because `generatedId()` mints globally unique ids (uuid v7,
 * or a 24-char ObjectId hex for pre-cutover rows) rather than per-table
 * sequences. Stated because it is an invariant of the ID SCHEME, not of this
 * function, and a per-table sequence would make this sweep another table's
 * files.
 */
export function getS3PodcastShowPrefixes(podcastId: string): readonly string[] {
  return [
    `${S3_HLS_PREFIX}/${podcastId}/`,
    `${S3_PODCAST_PREFIX}/audio/${podcastId}/`,
    `${S3_PODCAST_PREFIX}/cache/${podcastId}/`,
  ];
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
