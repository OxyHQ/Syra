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
 * delete as a prefix. The AES key goes into the same `TrackKey` collection under
 * the upload's id, which is what the locker stream endpoint reads.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { UserUploadModel } from '../../models/UserUpload';
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

export async function ingestUserUpload(
  uploadId: string,
  deps?: UploadIngestDeps,
): Promise<void> {
  const upload = await UserUploadModel.findById(uploadId);
  if (!upload) {
    throw new Error(`ingestUserUpload: upload not found: ${uploadId}`);
  }

  if (!upload.audioSource) {
    // Persist the terminal status before throwing, so the owner's library shows
    // a failed file rather than one stuck at "processing" forever.
    upload.status = 'failed';
    await upload.save().catch((saveErr) =>
      logger.error('[locker-ingest] failed to persist failed status', { uploadId, err: saveErr }),
    );
    throw new Error(`No source audio for upload ${uploadId}`);
  }

  upload.status = 'processing';
  await upload.save();

  const fetchSource = deps?.fetchSource ?? defaultFetchSource;
  const probe = deps?.probe ?? probeAudio;
  const packageHls = deps?.packageHls ?? packageToEncryptedHls;
  const doStoreHls = deps?.storeHls ?? storePackagedHls;
  const keyUri = deps?.keyUri ?? buildStreamKeyUri(uploadId);

  let cleanup: (() => void) | undefined;
  let outputDir: string | undefined;

  try {
    const fetched = await fetchSource(upload.audioSource.key, upload.audioSource.format);
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
      recordId: uploadId,
      buildKey: (relPath) => getS3LockerHlsKey(upload.ownerOxyUserId, uploadId, relPath),
    });

    upload.duration = probed.durationSec;
    if (probed.bitrateKbps !== undefined) {
      upload.bitrateKbps = probed.bitrateKbps;
    }
    if (probed.codec !== undefined) {
      upload.codec = probed.codec;
    }
    upload.hls = stored.hls;
    upload.hlsMasterKey = stored.hlsMasterKey;
    upload.loudnessLufs = result.loudnessLufs;
    upload.status = 'ready';
    await upload.save();
  } catch (err) {
    upload.status = 'failed';
    await upload.save().catch((saveErr) =>
      logger.error('[locker-ingest] failed to persist failed status', { uploadId, err: saveErr }),
    );
    logger.error('[locker-ingest] ingest failed', { uploadId, err });
    throw err;
  } finally {
    cleanup?.();
    if (outputDir) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
}
