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
import { getDb } from '../../db/postgres';
import { trackKeys } from '../../db/schema/trackKeys';
import type { PackageResult } from './hlsPackager';

/**
 * Which of `track_keys`' three parent columns a package's key is filed under.
 *
 * A TypeScript-level discriminator with no column behind it: the table used to
 * carry a `kind`, and the split into `track_id`/`user_upload_id`/`episode_id`
 * made the database express the same thing with three real foreign keys. It
 * stays here, at the seam that has to choose an arm, rather than in the schema
 * module, which no longer names these three values at all.
 */
export type TrackKeyKind = 'track' | 'user_upload' | 'episode';

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
   * Which id space {@link StoreHlsTarget.recordId} belongs to, and therefore
   * which of `track_keys`' three parent columns the AES key is filed under.
   *
   * Mongo stored the key row with no discriminator at all, so "these three id
   * spaces never collide" lived only in a comment. A caller has to say which of
   * the three it is holding — `'track'` from `ingestTrack`, `'user_upload'`
   * from `ingestUserUpload`, `'episode'` from `ingestEpisode` — and the column
   * that choice selects carries a real `ON DELETE cascade` back to that row.
   */
  kind: TrackKeyKind;
  /**
   * The id of the owning row — a `tracks.id`, a `user_uploads.id` or an
   * `episodes.id`, as {@link StoreHlsTarget.kind} says. It is what the AES key
   * is filed under in `track_keys`, which is how the stream and locker-stream
   * endpoints find it.
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
  const { kind, recordId, buildKey } = target;
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

  /**
   * Persist the AES-128 key server-side (upsert so re-imports are idempotent).
   *
   * The two arms this record does NOT belong to are set to an explicit `null`
   * rather than left off: `track_keys` is a discriminated union enforced by
   * `track_keys_one_parent_check`, and this is the one place that constructs
   * it, so it states all three columns instead of relying on the column default
   * to mean the same thing. (Drizzle would treat `undefined` as "omit" — the
   * same result on an INSERT, and a stale sibling on any future UPDATE.)
   *
   * BOTH THE VALUES AND THE CONFLICT TARGET ARE SELECTED BY `kind`, and the
   * target has to be the arm's OWN unique constraint. A fixed
   * `target: trackKeys.trackId` would never conflict for a locker or episode
   * row — `track_id` is null there and Postgres treats nulls as distinct — so a
   * re-ingest would insert a SECOND row and fail the arm's unique constraint
   * instead of rotating the key in place.
   */
  await getDb()
    .insert(trackKeys)
    .values({
      trackId: kind === 'track' ? recordId : null,
      userUploadId: kind === 'user_upload' ? recordId : null,
      episodeId: kind === 'episode' ? recordId : null,
      keyHex: result.keyHex,
      keyUri: result.keyUri,
    })
    .onConflictDoUpdate({
      target:
        kind === 'track'
          ? trackKeys.trackId
          : kind === 'user_upload'
            ? trackKeys.userUploadId
            : trackKeys.episodeId,
      // `updated_at` is absent on purpose: drizzle's `onConflictDoUpdate` runs
      // the same `buildUpdateSet` a `db.update()` does (`pg-core/dialect`), so
      // the column's `$onUpdate` fires here too. `created_at` has no
      // `$onUpdate` and is likewise untouched, which is what keeps the original
      // insertion time across a re-ingest. The parent columns are absent for a
      // different reason: they are the row's identity, and the conflict target
      // has already matched on one of them.
      set: { keyHex: result.keyHex, keyUri: result.keyUri },
    });

  // Build typed HlsRendition[] referencing S3 keys
  const hls: HlsRendition[] = result.renditions.map((r) => ({
    manifestKey: buildKey(r.playlistPath),
    bitrateKbps: r.bitrateKbps,
    encrypted: true,
  }));

  const hlsMasterKey = buildKey(result.masterPlaylistPath);

  return { hls, hlsMasterKey };
}
