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
import { eq } from 'drizzle-orm';
import type { AudioSource } from '@syra/shared-types';
import { getDb } from '../../db/postgres';
import { tracks, trackHlsRenditions } from '../../db/schema/catalog';
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
import { hasTrackFingerprint, indexTrackAcoustically } from '../../db/catalog/fingerprints';
import { buildStreamKeyUri } from './streamKeyUri';
import { storePreviewFromSourceFile } from '../preview/previewService';
import type { StorePreviewFromSourceParams } from '../preview/previewService';
import { describeErrorSafely } from '../../utils/error';

/** Offset of the default preview clip generated at ingest time. */
const DEFAULT_PREVIEW_START_SEC = 0;

// ── Dep types ────────────────────────────────────────────────────────────────

export interface FetchSourceResult {
  localPath: string;
  cleanup: () => void;
}

/**
 * The track columns ingest reads — everything needed to locate the source audio
 * in S3 and to key the HLS output.
 *
 * `audioSource` is reassembled from its four flat columns into the shape
 * `getTrackS3Key` takes, so the key layout is unchanged by the port.
 */
export interface IngestTrackSource {
  id: string;
  artistId: string;
  albumId?: string;
  audioSource?: AudioSource;
}

export interface IngestDeps {
  fetchSource?: (track: IngestTrackSource) => Promise<FetchSourceResult>;
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

async function defaultFetchSource(track: IngestTrackSource): Promise<FetchSourceResult> {
  if (!track.audioSource) {
    throw new Error(`No source audio for track ${track.id}`);
  }

  // `getTrackS3Key` takes the shared `Track` DTO but reads only these four
  // fields, which is exactly what `IngestTrackSource` carries.
  const s3Key = getTrackS3Key({
    id: track.id,
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
    if (await hasTrackFingerprint(trackId)) {
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
    logger.error('[ingest] acoustic indexing failed (non-fatal)', { trackId, err: describeErrorSafely(err) });
  }
}

// ── Main job ─────────────────────────────────────────────────────────────────

/** Load the four columns ingest needs, reassembling `audioSource`. */
async function loadIngestSource(trackId: string): Promise<IngestTrackSource | null> {
  const [row] = await getDb()
    .select({
      id: tracks.id,
      artistId: tracks.artistId,
      albumId: tracks.albumId,
      audioSourceUrl: tracks.audioSourceUrl,
      audioSourceFormat: tracks.audioSourceFormat,
      audioSourceBitrate: tracks.audioSourceBitrate,
      audioSourceDuration: tracks.audioSourceDuration,
    })
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    artistId: row.artistId,
    albumId: row.albumId ?? undefined,
    // `url` and `format` are what make an `AudioSource`; a track still
    // processing has neither, and a row with one but not the other cannot
    // locate a file either.
    audioSource:
      row.audioSourceUrl && row.audioSourceFormat
        ? {
            url: row.audioSourceUrl,
            format: row.audioSourceFormat,
            ...(row.audioSourceBitrate === null ? {} : { bitrate: row.audioSourceBitrate }),
            ...(row.audioSourceDuration === null ? {} : { duration: row.audioSourceDuration }),
          }
        : undefined,
  };
}

/** Persist a status transition on its own, never as part of a larger write. */
async function setStatus(trackId: string, status: 'processing' | 'failed'): Promise<void> {
  await getDb().update(tracks).set({ status }).where(eq(tracks.id, trackId));
}

/**
 * `setStatus`, with a write failure logged rather than raised.
 *
 * Used on the two paths that are ALREADY failing: an unreachable database there
 * must not replace the real ingest error with a write error nobody can act on.
 * The `processing` transition deliberately does not go through this — if that
 * write cannot land, the job has not started and the caller should hear so.
 */
async function setStatusQuietly(trackId: string, status: 'failed'): Promise<void> {
  await setStatus(trackId, status).catch((err: unknown) =>
    logger.error('[ingest] failed to persist failed status', { trackId, err: describeErrorSafely(err) }),
  );
}

export async function ingestTrack(
  trackId: string,
  deps?: IngestDeps,
  options?: IngestOptions,
): Promise<void> {
  const track = await loadIngestSource(trackId);
  if (!track) {
    throw new Error(`ingestTrack: track not found: ${trackId}`);
  }

  // Guard: audioSource required for transcoding
  if (!track.audioSource) {
    // Set failed immediately before throwing so the status is persisted
    await setStatusQuietly(trackId, 'failed');
    throw new Error(`No source audio for track ${trackId}`);
  }

  await setStatus(trackId, 'processing');

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
      kind: 'track',
      recordId: trackId,
      buildKey: (relPath) => getS3HlsKey(track.artistId, trackId, relPath),
    });

    /**
     * The measured audio facts, the rendition ladder and the `ready` status
     * commit TOGETHER.
     *
     * They were one `track.save()` under Mongo because `hls` was an embedded
     * array; `track_hls_renditions` is a child table now, and a track marked
     * `ready` with no rendition rows is a track the stream endpoint offers and
     * then cannot serve.
     */
    await getDb().transaction(async (tx) => {
      await tx
        .update(tracks)
        .set({
          audioSourceDuration: probed.durationSec,
          ...(probed.bitrateKbps !== undefined ? { audioSourceBitrate: probed.bitrateKbps } : {}),
          hlsMasterKey: stored.hlsMasterKey,
          loudnessLufs: result.loudnessLufs,
          status: 'ready',
        })
        .where(eq(tracks.id, trackId));

      // Re-ingest replaces the ladder rather than appending to it: the unique
      // `(track_id, position)` constraint would refuse a second pass otherwise,
      // and a ladder half from each pass is not a ladder.
      await tx.delete(trackHlsRenditions).where(eq(trackHlsRenditions.trackId, trackId));
      if (stored.hls.length > 0) {
        await tx.insert(trackHlsRenditions).values(
          stored.hls.map((rendition, position) => ({
            trackId,
            position,
            manifestKey: rendition.manifestKey,
            bitrateKbps: rendition.bitrateKbps,
            encrypted: rendition.encrypted,
          }))
        );
      }
    });

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
    await setStatusQuietly(trackId, 'failed');
    logger.error('[ingest] ingest failed', { trackId, err: describeErrorSafely(err) });
    throw err;
  } finally {
    cleanup?.();
    if (outputDir) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
}

