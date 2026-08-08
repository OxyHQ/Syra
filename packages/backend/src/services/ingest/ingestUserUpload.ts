/**
 * Locker ingest job orchestrator — the `UserUpload` twin of `ingestTrack`.
 *
 * Same pipeline (fetch source → package AES-128 encrypted HLS → store to S3 →
 * persist the per-file key → update the document) and the same injectable I/O
 * seams, differing in exactly two ways:
 *
 *  1. The ladder is `LOCKER_HLS_BITRATES_KBPS` — one rendition. A locker file is
 *     audible to one listener, so adaptive switching buys nothing and the
 *     transcode costs a third of a catalog track's.
 *  2. It reads and writes `UserUpload`, never `Track`. The two collections are
 *     separate precisely so a private file can never leak into a catalog query,
 *     and that separation would be pointless if ingest bridged them.
 *
 * The stored HLS is keyed by the OWNER id in place of an artist id, so every
 * object for one upload shares a directory that a takedown or expiry sweep can
 * delete as a prefix. The AES key goes into the same `track_keys` table under
 * the upload's id, which is what the locker stream endpoint reads.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { eq } from 'drizzle-orm';
import { describeDriverError } from '@oxyhq/db';
import { getDb, isDriverError } from '../../db/postgres';
import { userUploads } from '../../db/schema/creators';
import { setUploadHls } from '../../db/creators/uploads';
import { logger } from '../../utils/logger';
import { streamFromS3 } from '../s3Service';
import { packageToEncryptedHls, LOCKER_HLS_BITRATES_KBPS } from './hlsPackager';
import type { PackageOptions, PackageResult } from './hlsPackager';
import { storePackagedHls } from './hlsStorage';
import type { StoreHlsTarget, StoredHls } from './hlsStorage';
import { getS3LockerHlsKey } from '../../config/s3.config';
import { probeAudio } from './probeAudio';
import type { ProbedAudio } from './probeAudio';
import { buildStreamKeyUri } from './streamKeyUri';
import type { FetchSourceResult } from './ingestTrack';
import { describeErrorSafely } from '../../utils/error';

export interface UploadIngestDeps {
  fetchSource?: (s3Key: string, format: string) => Promise<FetchSourceResult>;
  probe?: (inputPath: string) => Promise<ProbedAudio>;
  packageHls?: (opts: PackageOptions) => Promise<PackageResult>;
  storeHls?: (result: PackageResult, target: StoreHlsTarget) => Promise<StoredHls>;
  keyUri?: string;
}

/** Stream the stored source object to a temp file ffmpeg can read. */
async function defaultFetchSource(s3Key: string, format: string): Promise<FetchSourceResult> {
  const { stream } = await streamFromS3(s3Key);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'locker-src-'));
  const localPath = path.join(tmpDir, `source.${format}`);

  await new Promise<void>((resolve, reject) => {
    const dest = fs.createWriteStream(localPath);
    (stream as Readable).pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
    (stream as Readable).on('error', reject);
  });

  return {
    localPath,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/**
 * Stamp a terminal `failed` status without letting the stamp itself throw.
 *
 * Every caller here is already on an error path: the owner's library must show
 * a failed file rather than one stuck at "processing" forever, and a write that
 * fails while recording a failure must not replace the real error.
 */
async function markFailed(uploadId: string): Promise<void> {
  await getDb()
    .update(userUploads)
    .set({ status: 'failed' })
    .where(eq(userUploads.id, uploadId))
    .catch((saveErr: unknown) =>
      // An UPDATE, so this is the database — and its bound parameters are the
      // row. Redacted rather than logged whole.
      logger.error('[locker-ingest] failed to persist failed status', {
        uploadId,
        ...(isDriverError(saveErr)
          ? { driver: describeDriverError(saveErr) }
          : { err: saveErr }),
      }),
    );
}

export async function ingestUserUpload(
  uploadId: string,
  deps?: UploadIngestDeps,
): Promise<void> {
  const [upload] = await getDb()
    .select({
      ownerOxyUserId: userUploads.ownerOxyUserId,
      audioSourceKey: userUploads.audioSourceKey,
      audioSourceFormat: userUploads.audioSourceFormat,
    })
    .from(userUploads)
    .where(eq(userUploads.id, uploadId))
    .limit(1);

  if (!upload) {
    throw new Error(`ingestUserUpload: upload not found: ${uploadId}`);
  }

  // Both halves, because `UploadAudioSource` was ONE embedded subdocument and
  // is two flattened columns now: a row carrying a key and no format is a shape
  // the old `if (!upload.audioSource)` could not produce and this one can.
  if (!upload.audioSourceKey || !upload.audioSourceFormat) {
    await markFailed(uploadId);
    throw new Error(`No source audio for upload ${uploadId}`);
  }
  const audioSource = { key: upload.audioSourceKey, format: upload.audioSourceFormat };

  await getDb().update(userUploads).set({ status: 'processing' }).where(eq(userUploads.id, uploadId));

  const fetchSource = deps?.fetchSource ?? defaultFetchSource;
  const probe = deps?.probe ?? probeAudio;
  const packageHls = deps?.packageHls ?? packageToEncryptedHls;
  const doStoreHls = deps?.storeHls ?? storePackagedHls;
  const keyUri = deps?.keyUri ?? buildStreamKeyUri(uploadId);

  let cleanup: (() => void) | undefined;
  let outputDir: string | undefined;

  try {
    const fetched = await fetchSource(audioSource.key, audioSource.format);
    cleanup = fetched.cleanup;

    const probed = await probe(fetched.localPath);

    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'locker-hls-'));
    const result = await packageHls({
      inputPath: fetched.localPath,
      outputDir,
      keyUri,
      bitratesKbps: LOCKER_HLS_BITRATES_KBPS,
    });

    // `hls/uploads/{owner}/{uploadId}/…` — a key space of the locker's own, NOT
    // the catalog's `hls/{artistId}/…`. A locker upload may have no artist at
    // all, and interleaving the two would leave a bucket lifecycle rule or an
    // audit written against `hls/{artistId}/` silently including listener files
    // with no way to tell them apart from the key.
    const stored = await doStoreHls(result, {
      kind: 'user_upload',
      recordId: uploadId,
      buildKey: (relPath) => getS3LockerHlsKey(upload.ownerOxyUserId, uploadId, relPath),
    });

    /**
     * The row and its HLS ladder are ONE logical result, so they land together.
     *
     * `hls[]` was an embedded array assigned in the same `save()` as the status;
     * it is `user_upload_hls_renditions` now, and a failure between the two
     * writes would leave a file reported `ready` with no ladder to play — the
     * one state the stream endpoint reads as "not playable" AFTER telling the
     * owner it was done.
     *
     * Only the measured fields are set. `bitrateKbps` and `codec` keep their
     * stored values when `ffprobe` did not report them, which is what the two
     * `!== undefined` guards meant on the document.
     */
    await getDb().transaction(async (tx) => {
      await tx
        .update(userUploads)
        .set({
          duration: probed.durationSec,
          ...(probed.bitrateKbps !== undefined && { bitrateKbps: probed.bitrateKbps }),
          ...(probed.codec !== undefined && { codec: probed.codec }),
          hlsMasterKey: stored.hlsMasterKey,
          loudnessLufs: result.loudnessLufs,
          status: 'ready',
        })
        .where(eq(userUploads.id, uploadId));
      await setUploadHls(tx, uploadId, stored.hls);
    });
  } catch (err) {
    await markFailed(uploadId);
    /**
     * This try spans an S3 read, `ffmpeg`, an S3 write and the final
     * transaction, so the branch decides which subsystem an operator reads
     * about. On the database side the bound parameters include this file's
     * whole HLS ladder and its measured loudness; on the other side the message
     * IS the diagnosis and must survive.
     */
    if (isDriverError(err)) {
      logger.error('[locker-ingest] ingest failed: the database refused the write', {
        uploadId,
        driver: describeDriverError(err),
      });
    } else {
      logger.error('[locker-ingest] ingest failed', { uploadId, err: describeErrorSafely(err) });
    }
    throw err;
  } finally {
    cleanup?.();
    if (outputDir) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
}
