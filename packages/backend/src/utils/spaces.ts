import { legacyStore, S3_BUCKET_NAME, S3_REGION, S3_ENDPOINT } from '../config/s3.config';
import { deleteFromS3 } from '../services/s3Service';

/**
 * The LEGACY house / room / series images in Syra's bucket.
 *
 * New space images are Oxy files (`services/oxyFiles/spaceImages.ts`); nothing
 * writes under `agora/houses|rooms|series/` any more. What is left here
 * recognises and deletes the old objects until `scripts/retireLegacyImageStorage.ts`
 * retires the prefixes. Room recordings are audio, and live in
 * `services/oxyFiles/audioStorage.ts`.
 */

/**
 * Optional public base URL for directly-servable objects (e.g. a CloudFront
 * distribution or a CDN in front of the bucket). When unset, falls back to the
 * S3 virtual-hosted URL derived from the configured bucket + region. Used to
 * build the persistent image URL stored on a room / house / series.
 */
const S3_PUBLIC_BASE_URL = process.env.S3_PUBLIC_BASE_URL?.replace(/\/+$/, '');

/**
 * Extract the stored object key from a public bucket URL Syra produced before
 * its images moved to Oxy Files (ADR 0043), or `null` when the URL is not one of
 * ours (an external host). Used to recognise a LEGACY house/room/series image —
 * to count reads of it and to delete it once replaced — without a hardcoded host.
 */
export function cdnUrlToKey(url: string | undefined | null): string | null {
  if (!url) return null;
  const bases = [
    S3_PUBLIC_BASE_URL,
    S3_ENDPOINT ? `${S3_ENDPOINT.replace(/\/+$/, '')}/${S3_BUCKET_NAME}` : undefined,
    `https://${S3_BUCKET_NAME}.s3.${S3_REGION}.amazonaws.com`,
    // Once R2 is the store, every URL Syra ever produced still names the S3
    // bucket — now the legacy store — and must still be recognised as ours.
    legacyStore
      ? `https://${legacyStore.bucket}.s3.${legacyStore.region}.amazonaws.com`
      : undefined,
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
