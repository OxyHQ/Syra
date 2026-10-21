import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  legacyStore,
  s3Client,
  S3_BUCKET_NAME,
  S3_REGION,
  S3_ENDPOINT,
  type ObjectStore,
} from '../config/s3.config';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/error';
import type { Readable } from 'stream';
import { describeErrorSafely } from '../utils/error';

interface AwsSdkError {
  name: string;
  message: string;
  Code?: string;
  HostId?: string;
  BucketName?: string;
  $metadata?: {
    httpStatusCode?: number;
    requestId?: string;
    extendedRequestId?: string;
  };
}

function asAwsError(error: unknown): AwsSdkError {
  if (error !== null && typeof error === 'object') {
    return error as AwsSdkError;
  }
  return { name: 'UnknownError', message: String(error) };
}

/**
 * S3 Service
 * Handles all S3 operations for audio files
 */

export interface S3UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface S3StreamOptions {
  start?: number;
  end?: number;
}

/**
 * Upload a file to S3
 */
export async function uploadToS3(
  key: string,
  body: Buffer | Readable | string,
  options: S3UploadOptions = {},
): Promise<void> {
  try {
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: options.contentType,
      Metadata: options.metadata,
    });

    logger.debug(`[S3Service] Uploading to S3:`, {
      bucket: S3_BUCKET_NAME,
      key,
      region: S3_REGION,
      endpoint: S3_ENDPOINT || 'default (AWS)',
      contentType: options.contentType,
    });

    await s3Client.send(command);
    logger.debug(`[S3Service] Uploaded file to S3: ${key}`);
  } catch (error: unknown) {
    const e = asAwsError(error);
    const errorDetails = {
      key,
      bucket: S3_BUCKET_NAME,
      region: S3_REGION,
      endpoint: S3_ENDPOINT || 'default (AWS)',
      errorCode: e.Code ?? e.name,
      errorMessage: e.message,
      httpStatusCode: e.$metadata?.httpStatusCode,
      requestId: e.$metadata?.requestId,
      hostId: e.HostId ?? e.$metadata?.extendedRequestId,
      errorBucketName: e.BucketName,
    };
    logger.error(`[S3Service] Error uploading to S3:`, errorDetails, {
      error: describeErrorSafely(error),
    });
    throw error;
  }
}

/**
 * Get a pre-signed URL for reading from S3
 * Expires after 1 hour by default
 */
export async function getPresignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
  try {
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn });
    logger.debug(`[S3Service] Generated pre-signed URL for: ${key}`);
    return url;
  } catch (error: unknown) {
    const e = asAwsError(error);
    const errorDetails = {
      key,
      bucket: S3_BUCKET_NAME,
      region: S3_REGION,
      endpoint: S3_ENDPOINT || 'default (AWS)',
      errorCode: e.Code ?? e.name,
      errorMessage: e.message,
    };
    logger.error(`[S3Service] Error generating pre-signed URL:`, errorDetails, {
      error: describeErrorSafely(error),
    });
    throw error;
  }
}

/**
 * Get object metadata from S3
 */
export async function getObjectMetadata(key: string): Promise<{
  contentLength?: number;
  contentType?: string;
  lastModified?: Date;
  etag?: string;
} | null> {
  try {
    const command = new HeadObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
    });

    const response = await s3Client.send(command);
    return {
      contentLength: response.ContentLength,
      contentType: response.ContentType,
      lastModified: response.LastModified,
      etag: response.ETag,
    };
  } catch (error: unknown) {
    const e = asAwsError(error);
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
      return null;
    }
    const errorDetails = {
      key,
      bucket: S3_BUCKET_NAME,
      region: S3_REGION,
      endpoint: S3_ENDPOINT || 'default (AWS)',
      errorCode: e.Code ?? e.name,
      errorMessage: e.message,
    };
    logger.error(`[S3Service] Error getting object metadata:`, errorDetails, {
      error: describeErrorSafely(error),
    });
    throw error;
  }
}

/**
 * Stream an object from S3 with optional range support
 */
export async function streamFromS3(
  key: string,
  options: S3StreamOptions = {},
): Promise<{
  stream: Readable;
  contentLength: number;
  contentType?: string;
  contentRange?: string;
}> {
  try {
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
      Range:
        options.start !== undefined && options.end !== undefined
          ? `bytes=${options.start}-${options.end}`
          : undefined,
    });

    const response = await s3Client.send(command);

    if (!response.Body) {
      throw new Error('No body in S3 response');
    }

    const stream = response.Body as Readable;
    const contentLength = response.ContentLength || 0;
    const contentType = response.ContentType;
    const contentRange = response.ContentRange;

    return {
      stream,
      contentLength,
      contentType,
      contentRange,
    };
  } catch (error: unknown) {
    const e = asAwsError(error);
    const errorDetails = {
      key,
      bucket: S3_BUCKET_NAME,
      region: S3_REGION,
      endpoint: S3_ENDPOINT || 'default (AWS)',
      errorCode: e.Code ?? e.name,
      errorMessage: e.message,
    };
    logger.error(`[S3Service] Error streaming from S3:`, errorDetails, {
      error: describeErrorSafely(error),
    });
    throw error;
  }
}

/**
 * Delete an object from S3
 */
export async function deleteFromS3(key: string): Promise<void> {
  try {
    const command = new DeleteObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
    });

    await s3Client.send(command);
    // Both stores while R2 migrates from S3: a copy left in S3 would be copied
    // back on the next read (OxyHQ/oxy ADR 0047).
    if (legacyStore) {
      await legacyStore.client.send(
        new DeleteObjectCommand({ Bucket: legacyStore.bucket, Key: key }),
      );
    }
    logger.debug(`[S3Service] Deleted file from S3: ${key}`);
  } catch (error: unknown) {
    const e = asAwsError(error);
    const errorDetails = {
      key,
      bucket: S3_BUCKET_NAME,
      region: S3_REGION,
      endpoint: S3_ENDPOINT || 'default (AWS)',
      errorCode: e.Code ?? e.name,
      errorMessage: e.message,
    };
    logger.error(`[S3Service] Error deleting from S3:`, errorDetails, {
      error: describeErrorSafely(error),
    });
    throw error;
  }
}

/**
 * Delete every object under a key prefix, and return how many were deleted.
 *
 * Needed because HLS output is a DIRECTORY: the document records the master
 * manifest and each variant manifest, but the segments beside them are named by
 * the packager and stored nowhere. Deleting only the recorded keys would leave
 * the actual audio in the bucket after the document that pointed at it is gone —
 * which for a copyright takedown is the difference between removing a work and
 * merely hiding it.
 *
 * The listing is paginated (S3 returns at most 1000 keys per page) and each page
 * is deleted in one batched call. The caller is responsible for passing a prefix
 * that belongs to exactly one object; this function will happily empty whatever
 * it is given.
 */
export async function deleteS3Prefix(prefix: string): Promise<number> {
  if (!prefix) {
    throw new Error('deleteS3Prefix requires a non-empty prefix');
  }

  try {
    const deleted = await deletePrefixIn({ client: s3Client, bucket: S3_BUCKET_NAME }, prefix);
    // The legacy store's own listing: an object not migrated yet is only there.
    if (legacyStore) await deletePrefixIn(legacyStore, prefix);
    logger.debug(`[S3Service] Deleted ${deleted} object(s) under prefix: ${prefix}`);
    return deleted;
  } catch (error: unknown) {
    const e = asAwsError(error);
    logger.error(
      `[S3Service] Error deleting prefix:`,
      {
        prefix,
        bucket: S3_BUCKET_NAME,
        errorCode: e.Code ?? e.name,
        errorMessage: e.message,
      },
      { error: describeErrorSafely(error) },
    );
    throw error;
  }
}

async function deletePrefixIn(
  target: Pick<ObjectStore, 'client' | 'bucket'>,
  prefix: string,
): Promise<number> {
  let deleted = 0;
  let continuationToken: string | undefined;
  do {
    const listed = await target.client.send(
      new ListObjectsV2Command({
        Bucket: target.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    const keys = (listed.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => typeof key === 'string');

    if (keys.length > 0) {
      await target.client.send(
        new DeleteObjectsCommand({
          Bucket: target.bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      deleted += keys.length;
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  return deleted;
}

/**
 * Every key under `prefix`, page by page (S3 answers at most 1000 a page).
 * Read-only; the caller decides what a key means.
 */
export async function* listS3Keys(prefix: string): AsyncGenerator<string> {
  if (!prefix) {
    throw new Error('listS3Keys requires a non-empty prefix');
  }
  const seen = legacyStore ? new Set<string>() : null;
  for await (const key of listKeysIn({ client: s3Client, bucket: S3_BUCKET_NAME }, prefix)) {
    seen?.add(key);
    yield key;
  }
  // While R2 migrates from S3, a key not migrated yet is only in S3.
  if (legacyStore && seen) {
    for await (const key of listKeysIn(legacyStore, prefix)) if (!seen.has(key)) yield key;
  }
}

async function* listKeysIn(
  target: Pick<ObjectStore, 'client' | 'bucket'>,
  prefix: string,
): AsyncGenerator<string> {
  let continuationToken: string | undefined;
  do {
    const listed = await target.client.send(
      new ListObjectsV2Command({
        Bucket: target.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of listed.Contents ?? []) {
      if (typeof object.Key === 'string') yield object.Key;
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * Delete an explicit list of keys, batched at S3's own limit (1000 per
 * `DeleteObjects` call). Unlike `deleteS3Prefix`, the caller already knows
 * every key — there is nothing to list first, and the keys need not share a
 * prefix at all.
 */
export async function deleteFromS3Batch(keys: readonly string[]): Promise<number> {
  const BATCH_SIZE = 1000;
  let deleted = 0;

  try {
    for (let start = 0; start < keys.length; start += BATCH_SIZE) {
      const batch = keys.slice(start, start + BATCH_SIZE);
      if (batch.length === 0) continue;

      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: S3_BUCKET_NAME,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      if (legacyStore) {
        await legacyStore.client.send(
          new DeleteObjectsCommand({
            Bucket: legacyStore.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
      deleted += batch.length;
    }

    logger.debug(`[S3Service] Deleted ${deleted} object(s) by explicit key list`);
    return deleted;
  } catch (error: unknown) {
    const e = asAwsError(error);
    logger.error(
      `[S3Service] Error deleting explicit key batch:`,
      {
        keyCount: keys.length,
        bucket: S3_BUCKET_NAME,
        errorCode: e.Code ?? e.name,
        errorMessage: e.message,
      },
      { error: describeErrorSafely(error) },
    );
    throw error;
  }
}

/**
 * Check if an object exists in S3
 */
export async function objectExists(key: string): Promise<boolean> {
  try {
    const metadata = await getObjectMetadata(key);
    return metadata !== null;
  } catch (error) {
    return false;
  }
}

/**
 * Every object under `prefix` with when it was last written, page by page —
 * the store's, then (while R2 migrates from S3) what only the legacy store
 * holds. Read-only, like {@link listS3Keys}; for a caller that decides by age.
 */
export async function* listS3Objects(
  prefix: string,
): AsyncGenerator<{ key: string; lastModified: Date | undefined }> {
  if (!prefix) {
    throw new Error('listS3Objects requires a non-empty prefix');
  }
  const seen = legacyStore ? new Set<string>() : null;
  for await (const object of listObjectsIn({ client: s3Client, bucket: S3_BUCKET_NAME }, prefix)) {
    seen?.add(object.key);
    yield object;
  }
  if (legacyStore && seen) {
    for await (const object of listObjectsIn(legacyStore, prefix)) {
      if (!seen.has(object.key)) yield object;
    }
  }
}

async function* listObjectsIn(
  target: Pick<ObjectStore, 'client' | 'bucket'>,
  prefix: string,
): AsyncGenerator<{ key: string; lastModified: Date | undefined }> {
  let continuationToken: string | undefined;
  do {
    const listed = await target.client.send(
      new ListObjectsV2Command({
        Bucket: target.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of listed.Contents ?? []) {
      if (typeof object.Key === 'string') {
        yield { key: object.Key, lastModified: object.LastModified };
      }
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

export interface PresignedUploadOptions {
  /** The ONLY Content-Type the URL admits; the object is stored with it. */
  contentType: string;
  /** The EXACT body size the URL admits. */
  contentLength: number;
  expiresInSeconds: number;
}

/**
 * A presigned PUT for exactly one object at `key`, of exactly `contentType`
 * and exactly `contentLength` bytes.
 *
 * Both are SIGNED headers (`X-Amz-SignedHeaders: content-length;content-type;
 * host`), so storage refuses a body of any other length or a request declaring
 * any other type — the signature no longer matches. A PUT rather than a POST
 * policy because the store is Cloudflare R2 (OxyHQ/oxy ADR 0047), whose S3 API
 * has no browser-form uploads; the same URL works against S3. Signing needs no
 * request to storage.
 */
export async function createPresignedUpload(
  key: string,
  options: PresignedUploadOptions,
): Promise<{ url: string; headers: Record<string, string> }> {
  const url = await getSignedUrl(
    s3Client,
    new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
      ContentType: options.contentType,
      ContentLength: options.contentLength,
    }),
    {
      expiresIn: options.expiresInSeconds,
      // Content-Length is signed by default; Content-Type only when asked.
      signableHeaders: new Set(['content-type', 'content-length']),
    },
  );
  // Content-Length is not listed: every client sets it from the body, and a
  // browser refuses to let a page set it at all.
  return { url, headers: { 'Content-Type': options.contentType } };
}

/**
 * Copy an object to another key inside the bucket, replacing its type and
 * metadata. Server-side: no byte passes through this process. A single
 * CopyObject handles objects up to 5 GB, ten times the largest upload Syra
 * accepts.
 */
export async function copyWithinS3(
  sourceKey: string,
  destinationKey: string,
  options: S3UploadOptions = {},
): Promise<void> {
  try {
    await s3Client.send(
      new CopyObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: destinationKey,
        CopySource: `${S3_BUCKET_NAME}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`,
        MetadataDirective: 'REPLACE',
        ContentType: options.contentType,
        Metadata: options.metadata,
      }),
    );
    logger.debug(`[S3Service] Copied ${sourceKey} to ${destinationKey}`);
  } catch (error: unknown) {
    const e = asAwsError(error);
    logger.error(
      `[S3Service] Error copying within S3:`,
      {
        sourceKey,
        destinationKey,
        bucket: S3_BUCKET_NAME,
        errorCode: e.Code ?? e.name,
        errorMessage: e.message,
      },
      { error: describeErrorSafely(error) },
    );
    throw error;
  }
}
