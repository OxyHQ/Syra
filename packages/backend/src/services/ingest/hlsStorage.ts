/**
 * HLS storage service.
 *
 * Uploads all files produced by hlsPackager to S3, persists the AES-128
 * key server-side in TrackKey, and returns the typed HlsRendition[] and
 * hlsMasterKey needed to update the Track document.
 *
 * The `upload` dependency is injected so callers can swap in a fake for tests
 * — no real S3 credentials required in test environments.
 */

import fs from 'fs';
import path from 'path';
import type { HlsRendition } from '@syra/shared-types';
import { getS3HlsKey } from '../../config/s3.config';
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
  ids: { trackId: string; artistId: string },
  deps?: StoreHlsDeps,
): Promise<StoredHls> {
  const { trackId, artistId } = ids;
  const doUpload = deps?.upload ?? ((key, body, opts) => uploadToS3(key, body, opts));

  // Upload every file in outputDir to S3
  const allFiles = collectFiles(result.outputDir);
  await Promise.all(
    allFiles.map((absPath) => {
      const relPath = path.relative(result.outputDir, absPath).replace(/\\/g, '/');
      const s3Key = getS3HlsKey(artistId, trackId, relPath);
      const body = fs.readFileSync(absPath);
      const contentType = contentTypeForExt(path.extname(absPath));
      return doUpload(s3Key, body, { contentType });
    }),
  );

  // Persist the AES-128 key server-side (upsert so re-imports are idempotent)
  await TrackKeyModel.findOneAndUpdate(
    { trackId },
    { keyHex: result.keyHex, keyUri: result.keyUri },
    { upsert: true, new: true },
  );

  // Build typed HlsRendition[] referencing S3 keys
  const hls: HlsRendition[] = result.renditions.map((r) => ({
    manifestKey: getS3HlsKey(artistId, trackId, r.playlistPath),
    bitrateKbps: r.bitrateKbps,
    encrypted: true,
  }));

  const hlsMasterKey = getS3HlsKey(artistId, trackId, result.masterPlaylistPath);

  return { hls, hlsMasterKey };
}
