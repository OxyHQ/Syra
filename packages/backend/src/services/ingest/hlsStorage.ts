/**
 * HLS storage service.
 *
 * Uploads all files produced by hlsPackager to S3, persists the AES-128
 * key server-side in TrackKey, and returns the typed HlsRendition[] and
 * hlsMasterKey needed to update the owning document.
 *
 * The caller supplies the key builder rather than this module choosing one,
 * because catalog tracks and personal-locker uploads deliberately live in
 * different key spaces (`hls/{artistId}/…` vs `hls/uploads/{ownerId}/…`) and a
 * locker upload has no artist id to key by. See `StoreHlsTarget`.
 *
 * The `upload` dependency is injected so callers can swap in a fake for tests
 * — no real S3 credentials required in test environments.
 */

import fs from 'fs';
import path from 'path';
import type { HlsRendition } from '@syra/shared-types';
import { uploadToS3 } from '../s3Service';
import { TrackKeyModel } from '../../models/TrackKey';
import type { PackageResult } from './hlsPackager';

// ── Content-type map ─────────────────────────────────────────────────────────

const CONTENT_TYPE_HLS_PLAYLIST = 'application/vnd.apple.mpegurl';
const CONTENT_TYPE_MPEG_TS = 'video/mp2t';
const CONTENT_TYPE_OCTET_STREAM = 'application/octet-stream';

function contentTypeForExt(ext: string): string {
  if (ext === '.m3u8') return CONTENT_TYPE_HLS_PLAYLIST;
  if (ext === '.ts') return CONTENT_TYPE_MPEG_TS;
  return CONTENT_TYPE_OCTET_STREAM;
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface StoredHls {
  hls: HlsRendition[];
  hlsMasterKey: string;
}

/** What the packaged output belongs to, and where its objects go. */
export interface StoreHlsTarget {
  /**
   * The id of the owning document — a `Track._id` or a `UserUpload._id`. It is
   * what the AES key is filed under in `TrackKey`, which is how the stream and
   * locker-stream endpoints find it.
   */
  recordId: string;
  /**
   * Builds the S3 key for one file at `relPath` within this record's output.
   *   catalog: `getS3HlsKey(artistId, trackId, relPath)`
   *   locker:  `getS3LockerHlsKey(ownerOxyUserId, uploadId, relPath)`
   *
   * Whatever it returns MUST keep `recordId` as a whole path segment above the
   * manifest filename. `compliance/takedown.ts` derives its delete prefix by
   * finding that segment and refuses to sweep a key without it — degrading a
   * purge to "recorded manifests only" and stranding every segment in the
   * bucket, with no error and no orphan report.
   */
  buildKey: (relPath: string) => string;
}

export interface StoreHlsDeps {
  upload?: (key: string, body: Buffer, opts: { contentType: string }) => Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Recursively collect all file paths under a directory. */
function collectFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function storePackagedHls(
  result: PackageResult,
  target: StoreHlsTarget,
  deps?: StoreHlsDeps,
): Promise<StoredHls> {
  const { recordId, buildKey } = target;
  const doUpload = deps?.upload ?? ((key, body, opts) => uploadToS3(key, body, opts));

  // Upload every file in outputDir to S3
  const allFiles = collectFiles(result.outputDir);
  await Promise.all(
    allFiles.map((absPath) => {
      const relPath = path.relative(result.outputDir, absPath).replace(/\\/g, '/');
      const s3Key = buildKey(relPath);
      const body = fs.readFileSync(absPath);
      const contentType = contentTypeForExt(path.extname(absPath));
      return doUpload(s3Key, body, { contentType });
    }),
  );

  // Persist the AES-128 key server-side (upsert so re-imports are idempotent).
  // `TrackKey.trackId` holds a Track id for catalog jobs and a UserUpload id for
  // locker jobs; the two id spaces are distinct ObjectIds, so they cannot collide.
  await TrackKeyModel.findOneAndUpdate(
    { trackId: recordId },
    { keyHex: result.keyHex, keyUri: result.keyUri },
    { upsert: true, new: true },
  );

  // Build typed HlsRendition[] referencing S3 keys
  const hls: HlsRendition[] = result.renditions.map((r) => ({
    manifestKey: buildKey(r.playlistPath),
    bitrateKbps: r.bitrateKbps,
    encrypted: true,
  }));

  const hlsMasterKey = buildKey(result.masterPlaylistPath);

  return { hls, hlsMasterKey };
}
