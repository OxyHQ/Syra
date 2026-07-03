import { S3_BUCKET_NAME, S3_REGION, S3_ENDPOINT } from '../config/s3.config';
import { uploadToS3, getPresignedUrl, deleteFromS3 } from '../services/s3Service';

/**
 * Object-storage helpers for the live-rooms slice (room / house / series images
 * and room recordings). Thin adapters over Syra's canonical S3 layer
 * (`config/s3.config` + `services/s3Service`) so the room routes and the LiveKit
 * egress client share one storage authority. Public read access to the
 * `agora/*` prefixes is governed by the bucket policy, not per-object ACLs
 * (matching Syra's other S3 objects).
 */

/**
 * Optional public base URL for directly-servable objects (e.g. a CloudFront
 * distribution or a CDN in front of the bucket). When unset, falls back to the
 * S3 virtual-hosted URL derived from the configured bucket + region. Used to
 * build the persistent image URL stored on a room / house / series.
 */
const S3_PUBLIC_BASE_URL = process.env.S3_PUBLIC_BASE_URL?.replace(/\/+$/, '');

/**
 * Build a public, directly-servable URL for a stored object key. Prefers
 * `S3_PUBLIC_BASE_URL`, then a custom S3 endpoint (`AWS_ENDPOINT_URL`, e.g.
 * LocalStack / MinIO / Spaces), else the standard AWS virtual-hosted URL.
 */
export function getCdnUrl(objectKey: string): string {
  if (S3_PUBLIC_BASE_URL) {
    return `${S3_PUBLIC_BASE_URL}/${objectKey}`;
  }
  if (S3_ENDPOINT) {
    return `${S3_ENDPOINT.replace(/\/+$/, '')}/${S3_BUCKET_NAME}/${objectKey}`;
  }
  return `https://${S3_BUCKET_NAME}.s3.${S3_REGION}.amazonaws.com/${objectKey}`;
}

/**
 * Reverse of {@link getCdnUrl}: extract the stored object key from a public CDN
 * URL this module previously produced, or `null` when the URL is not one of
 * ours (external / legacy host). Used to clean up a superseded image on
 * re-upload without a hardcoded host.
 */
export function cdnUrlToKey(url: string | undefined | null): string | null {
  if (!url) return null;
  const bases = [
    S3_PUBLIC_BASE_URL,
    S3_ENDPOINT ? `${S3_ENDPOINT.replace(/\/+$/, '')}/${S3_BUCKET_NAME}` : undefined,
    `https://${S3_BUCKET_NAME}.s3.${S3_REGION}.amazonaws.com`,
  ];
  for (const base of bases) {
    if (base && url.startsWith(`${base}/`)) {
      return url.slice(base.length + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Generic object operations
// ---------------------------------------------------------------------------

export async function deleteObject(objectKey: string): Promise<void> {
  return deleteFromS3(objectKey);
}

/**
 * Upload a buffer to object storage. Returns the public CDN URL for a
 * `'public-read'` upload (callers store it as an image URL) and the raw object
 * key for a `'private'` upload (fetched later via a presigned URL). Public vs
 * private access is governed by the bucket policy, not per-object ACLs.
 */
export async function uploadObject(
  objectKey: string,
  body: Buffer | Uint8Array | string,
  contentType: string,
  acl: 'private' | 'public-read' = 'private',
): Promise<string> {
  await uploadToS3(objectKey, Buffer.isBuffer(body) ? body : Buffer.from(body), { contentType });
  return acl === 'public-read' ? getCdnUrl(objectKey) : objectKey;
}

// ---------------------------------------------------------------------------
// Agora media key helpers
// ---------------------------------------------------------------------------

export function getAgoraHouseAvatarKey(houseId: string): string {
  return `agora/houses/${houseId}/avatar.webp`;
}

export function getAgoraHouseCoverKey(houseId: string): string {
  return `agora/houses/${houseId}/cover.webp`;
}

export function getAgoraRoomImageKey(roomId: string): string {
  return `agora/rooms/${roomId}/image.webp`;
}

export function getAgoraSeriesCoverKey(seriesId: string): string {
  return `agora/series/${seriesId}/cover.webp`;
}

// ---------------------------------------------------------------------------
// Recording-specific helpers
// ---------------------------------------------------------------------------

export function getRecordingObjectKey(roomId: string, recordingId: string): string {
  return `agora/recordings/${roomId}/${recordingId}.ogg`;
}

export async function getRecordingPresignedUrl(
  objectKey: string,
  expiresInSeconds: number = 3600,
): Promise<string> {
  return getPresignedUrl(objectKey, expiresInSeconds);
}

export async function deleteRecordingFromSpaces(objectKey: string): Promise<void> {
  return deleteFromS3(objectKey);
}

/**
 * S3 upload config handed to the LiveKit EgressClient so it writes the room
 * recording directly to the same bucket. LiveKit's S3 uploader needs STATIC
 * credentials (it cannot assume the ECS task role), read from the same
 * `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` pair as `config/s3.config`.
 * Bucket / region / endpoint are the canonical S3 config values. When the
 * credentials are absent, egress uploads will fail to authenticate at runtime —
 * a deployment concern, not a build concern.
 */
export function getS3UploadConfig(objectKey: string) {
  return {
    accessKey: process.env.AWS_ACCESS_KEY_ID || '',
    secret: process.env.AWS_SECRET_ACCESS_KEY || '',
    bucket: S3_BUCKET_NAME,
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    filepath: objectKey,
    forcePathStyle: Boolean(S3_ENDPOINT),
  };
}
