/**
 * Reading Syra's LEGACY bucket objects whole — what the copy-to-Oxy migrations
 * read, and nothing else. Images are served from the bucket by streaming
 * (`imageAssetService.resolveImageAsset`); a migration needs the bytes in hand
 * to hash them before and after the copy.
 */

import { createHash } from 'node:crypto';
import { streamFromS3 } from '../s3Service';

/** The most a migration reads into memory: Oxy's own upload ceiling. */
export const LEGACY_OBJECT_MAX_BYTES = 40 * 1024 * 1024;

/** `null` when the bucket has no such object. */
export type LegacyObjectReader = (
  key: string,
) => Promise<{ bytes: Buffer; contentType?: string } | null>;

function isMissingObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    record.name === 'NoSuchKey' ||
    record.Code === 'NoSuchKey' ||
    record.name === 'NotFound' ||
    record.$metadata?.httpStatusCode === 404
  );
}

export class LegacyObjectTooLargeError extends Error {
  constructor(readonly key: string) {
    super(`Legacy object ${key} is larger than ${LEGACY_OBJECT_MAX_BYTES} bytes`);
    this.name = 'LegacyObjectTooLargeError';
  }
}

export const readLegacyObject: LegacyObjectReader = async (key) => {
  let opened: Awaited<ReturnType<typeof streamFromS3>>;
  try {
    opened = await streamFromS3(key);
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  }
  if (opened.contentLength > LEGACY_OBJECT_MAX_BYTES) {
    opened.stream.destroy();
    throw new LegacyObjectTooLargeError(key);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of opened.stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > LEGACY_OBJECT_MAX_BYTES) {
      opened.stream.destroy();
      throw new LegacyObjectTooLargeError(key);
    }
    chunks.push(buffer);
  }
  return {
    bytes: Buffer.concat(chunks),
    ...(opened.contentType ? { contentType: opened.contentType } : {}),
  };
};

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
