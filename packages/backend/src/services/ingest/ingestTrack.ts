/**
 * Ingest job orchestrator.
 *
 * Coordinates: fetch source audio → package encrypted HLS → store to S3 → update Track.
 * All external I/O dependencies are injectable so the unit tests run without
 * ffmpeg, S3, or real files.
 *
 * Status transitions:
 *   processing (set on enqueue) → ready (success) | failed (any error in 3–6)
 *
 * `enqueueIngest` is a fire-and-forget seam for a future durable queue.
 * Durability/retries are a follow-up; status='failed' in the DB makes a
 * failed track re-ingestable by re-calling enqueueIngest.
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
import type { StoredHls } from './hlsStorage';
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
  packageHls?: (opts: PackageOptions) => Promise<PackageResult>;
  storeHls?: (
    result: PackageResult,
    ids: { trackId: string; artistId: string },
  ) => Promise<StoredHls>;
  generatePreview?: (params: StorePreviewFromSourceParams) => Promise<string>;
  keyUri?: string;
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

// ── Main job ─────────────────────────────────────────────────────────────────

export async function ingestTrack(trackId: string, deps?: IngestDeps): Promise<void> {
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
  const packageHls = deps?.packageHls ?? packageToEncryptedHls;
  const doStoreHls = deps?.storeHls ?? storePackagedHls;
  const generatePreview = deps?.generatePreview ?? storePreviewFromSourceFile;
  const keyUri = deps?.keyUri ?? buildStreamKeyUri(trackId);

  let cleanup: (() => void) | undefined;
  let outputDir: string | undefined;

  try {
    const fetched = await fetchSource(track);
    cleanup = fetched.cleanup;

    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-hls-'));
    const result = await packageHls({ inputPath: fetched.localPath, outputDir, keyUri });

    const stored = await doStoreHls(result, { trackId, artistId: track.artistId });

    track.hls = stored.hls;
    track.hlsMasterKey = stored.hlsMasterKey;
    track.loudnessLufs = result.loudnessLufs;
    track.status = 'ready';
    await track.save();

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

// ── Fire-and-forget enqueue seam ──────────────────────────────────────────────

export function enqueueIngest(trackId: string): void {
  // Durability and retries are a follow-up concern; status='failed' in the DB
  // makes a failed track re-ingestable by re-calling enqueueIngest.
  ingestTrack(trackId).catch((err) =>
    logger.error('[ingest] failed', { trackId, err }),
  );
}
