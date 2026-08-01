/**
 * Ingest job orchestrator.
 *
 * Coordinates: fetch source audio → probe → package encrypted HLS → store to S3
 * → update Track. All external I/O dependencies are injectable so the unit tests
 * run without ffmpeg, S3, or real files.
 *
 * Status transitions:
 *   processing (set on enqueue) → ready (success) | failed (any error)
 *
 * Delivery is owned by `./ingestQueue` (BullMQ over REDIS_URL, in-process
 * fallback when Redis is not configured). `status='failed'` in the DB is the
 * durable outcome record, which also makes a failed track re-ingestable by
 * re-enqueueing it.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { TrackModel } from '../../models/Track';
import { logger } from '../../utils/logger';
import { getTrackS3Key } from '../audioStorageService';
import { streamFromS3 } from '../s3Service';
import { packageToEncryptedHls } from './hlsPackager';
import type { PackageOptions, PackageResult } from './hlsPackager';
import { storePackagedHls } from './hlsStorage';
import type { StoreHlsTarget, StoredHls } from './hlsStorage';
import { getS3HlsKey } from '../../config/s3.config';
import { probeAudio } from './probeAudio';
import type { ProbedAudio } from './probeAudio';
import { fingerprintFile } from '../uploads/fingerprint';
import type { FingerprintResult } from '../uploads/fingerprint';
import { TrackFingerprintModel, indexTrackAcoustically } from '../../models/TrackFingerprint';
import { buildStreamKeyUri } from './streamKeyUri';
import { storePreviewFromSourceFile } from '../preview/previewService';
import type { StorePreviewFromSourceParams } from '../preview/previewService';
import type { ITrack } from '../../models/Track';

/** Offset of the default preview clip generated at ingest time. */
const DEFAULT_PREVIEW_START_SEC = 0;

// ── Dep types ────────────────────────────────────────────────────────────────

export interface FetchSourceResult {
  localPath: string;
  cleanup: () => void;
}

export interface IngestDeps {
  fetchSource?: (track: ITrack) => Promise<FetchSourceResult>;
  probe?: (inputPath: string) => Promise<ProbedAudio>;
  fingerprint?: (inputPath: string) => Promise<FingerprintResult>;
  indexFingerprint?: (
    trackId: string,
    fingerprint: { values: number[]; durationSec: number },
  ) => Promise<boolean>;
  packageHls?: (opts: PackageOptions) => Promise<PackageResult>;
  storeHls?: (result: PackageResult, target: StoreHlsTarget) => Promise<StoredHls>;
  generatePreview?: (params: StorePreviewFromSourceParams) => Promise<string>;
  keyUri?: string;
}

/** Per-job parameters (as opposed to `IngestDeps`, which are I/O seams). */
export interface IngestOptions {
  /**
   * Rendition ladder in kbps. Defaults to the catalog ladder; personal-locker
   * uploads pass `LOCKER_HLS_BITRATES_KBPS`.
   */
  bitratesKbps?: readonly number[];
}

// ── Default fetchSource: stream from S3 to a temp file ───────────────────────

async function defaultFetchSource(track: ITrack): Promise<FetchSourceResult> {
  if (!track.audioSource) {
    throw new Error(`No source audio for track ${track._id.toString()}`);
  }

  // getTrackS3Key expects the shared Track type; ITrack is Track minus the virtual id.
  // We provide the fields it actually uses (id, artistId, albumId, audioSource).
  const s3Key = getTrackS3Key({
    id: track._id.toString(),
    artistId: track.artistId,
    albumId: track.albumId,
    audioSource: track.audioSource,
  } as Parameters<typeof getTrackS3Key>[0]);
  const { stream } = await streamFromS3(s3Key);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-src-'));
  const localPath = path.join(tmpDir, `source.${track.audioSource.format}`);

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

// ── Acoustic index ───────────────────────────────────────────────────────────

/**
 * Compute and store the track's Chromaprint row.
 *
 * Never throws: every outcome is reported and swallowed, because an unindexed
 * track that plays is a better result than a failed ingest, and the row is
 * recoverable by re-running `backfillTrackFingerprints`.
 *
 * The three non-`ok` outcomes are logged DIFFERENTLY on purpose. `unavailable`
 * means fpcalc is missing from the image — an operational fault affecting every
 * track, so it is a warning about the deployment, not about this file. `failed`
 * means fpcalc rejected this particular file. A refused write means the
 * fingerprint came back empty or with a nonsensical duration, and
 * `indexTrackAcoustically` declines those rather than storing a row that would
 * sit in the candidate bucket matching nothing.
 */
async function indexTrackFingerprint(
  trackId: string,
  inputPath: string,
  fingerprint: (inputPath: string) => Promise<FingerprintResult>,
  indexFingerprint: (
    trackId: string,
    fingerprint: { values: number[]; durationSec: number },
  ) => Promise<boolean>,
): Promise<void> {
  try {
    /**
     * A row already present means a producer that knows the fingerprint put it
     * there — the promote path, which carries the `UserUpload.fingerprint`
     * computed when the file entered the locker, or the backfill script. Running
     * fpcalc again over the same audio would spend seconds to upsert the values
     * that are already stored.
     *
     * Safe because a fingerprint is a property of the audio, and nothing replaces
     * the audio under an existing track id: re-ingest re-packages the same source.
     */
    if (await TrackFingerprintModel.exists({ trackId })) {
      logger.debug('[ingest] track already indexed acoustically — skipping fpcalc', { trackId });
      return;
    }

    const result = await fingerprint(inputPath);

    if (result.status === 'unavailable') {
      logger.warn('[ingest] fpcalc unavailable — track left unindexed acoustically', {
        trackId,
        reason: result.reason,
      });
      return;
    }
    if (result.status === 'failed') {
      logger.warn('[ingest] fingerprinting failed — track left unindexed acoustically', {
        trackId,
        reason: result.reason,
      });
      return;
    }

    const written = await indexFingerprint(trackId, {
      values: result.values,
      durationSec: result.durationSec,
    });
    if (!written) {
      logger.warn('[ingest] fingerprint refused as unusable — no row written', {
        trackId,
        valueCount: result.values.length,
        durationSec: result.durationSec,
      });
    }
  } catch (err) {
    logger.error('[ingest] acoustic indexing failed (non-fatal)', { trackId, err });
  }
}

// ── Main job ─────────────────────────────────────────────────────────────────

export async function ingestTrack(
  trackId: string,
  deps?: IngestDeps,
  options?: IngestOptions,
): Promise<void> {
  const track = await TrackModel.findById(trackId);
  if (!track) {
    throw new Error(`ingestTrack: track not found: ${trackId}`);
  }

  // Guard: audioSource required for transcoding
  if (!track.audioSource) {
    // Set failed immediately before throwing so the status is persisted
    track.status = 'failed';
    await track.save().catch((saveErr) =>
      logger.error('[ingest] failed to persist failed status', { trackId, err: saveErr }),
    );
    throw new Error(`No source audio for track ${trackId}`);
  }

  track.status = 'processing';
  await track.save();

  const fetchSource = deps?.fetchSource ?? defaultFetchSource;
  const probe = deps?.probe ?? probeAudio;
  const fingerprint = deps?.fingerprint ?? fingerprintFile;
  const indexFingerprint = deps?.indexFingerprint ?? indexTrackAcoustically;
  const packageHls = deps?.packageHls ?? packageToEncryptedHls;
  const doStoreHls = deps?.storeHls ?? storePackagedHls;
  const generatePreview = deps?.generatePreview ?? storePreviewFromSourceFile;
  const keyUri = deps?.keyUri ?? buildStreamKeyUri(trackId);

  let cleanup: (() => void) | undefined;
  let outputDir: string | undefined;

  try {
    const fetched = await fetchSource(track);
    cleanup = fetched.cleanup;

    // The stored bytes are the authority for duration and bitrate — the two
    // audioSource fields the schema has always declared and no code path has
    // ever written. Measured before packaging so a corrupt file fails here
    // rather than after a full transcode.
    const probed = await probe(fetched.localPath);

    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-hls-'));
    const result = await packageHls({
      inputPath: fetched.localPath,
      outputDir,
      keyUri,
      ...(options?.bitratesKbps && { bitratesKbps: options.bitratesKbps }),
    });

    const stored = await doStoreHls(result, {
      recordId: trackId,
      buildKey: (relPath) => getS3HlsKey(track.artistId, trackId, relPath),
    });

    track.audioSource.duration = probed.durationSec;
    if (probed.bitrateKbps !== undefined) {
      track.audioSource.bitrate = probed.bitrateKbps;
    }
    track.hls = stored.hls;
    track.hlsMasterKey = stored.hlsMasterKey;
    track.loudnessLufs = result.loudnessLufs;
    track.status = 'ready';
    await track.save();

    // Acoustic index for the catalogue. Best-effort, like the preview below: a
    // track that plays is worth more than one that is perfectly indexed, and
    // `backfillTrackFingerprints` can fill any gap later.
    //
    // Without this row the catalogue side of two features is silently a no-op —
    // the matcher's Chromaprint tier (which is what catches a re-encode or a
    // differently-tagged copy that sha256 and ISRC both miss) queries an empty
    // duration bucket forever, and a copyright takedown cannot find locker
    // copies of the same recording that hash differently. The second of those is
    // a safe-harbour obligation, which is why it is wired at ingest rather than
    // left to the backfill script.
    await indexTrackFingerprint(trackId, fetched.localPath, fingerprint, indexFingerprint);

    // Best-effort default preview clip from the already-local source. A preview
    // failure must NOT fail an otherwise-successful ingest — log and continue.
    try {
      await generatePreview({
        trackId,
        inputPath: fetched.localPath,
        startSec: DEFAULT_PREVIEW_START_SEC,
      });
    } catch (previewErr) {
      logger.error('[ingest] preview generation failed (non-fatal)', {
        trackId,
        err: previewErr,
      });
    }
  } catch (err) {
    track.status = 'failed';
    await track.save().catch((saveErr) =>
      logger.error('[ingest] failed to persist failed status', { trackId, err: saveErr }),
    );
    logger.error('[ingest] ingest failed', { trackId, err });
    throw err;
  } finally {
    cleanup?.();
    if (outputDir) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
}

