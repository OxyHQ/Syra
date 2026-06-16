import type { ExternalTrack } from '@syra/shared-types';
import { ImportJobModel, IImportJob } from '../../models/ImportJob';
import { upsertArtist } from '../catalog/upsertArtist';
import { upsertTrack } from '../catalog/upsertTrack';
import { enqueueIngest as defaultEnqueueIngest } from '../ingest/ingestTrack';
import { uploadTrackAudio } from '../audioStorageService';
import { TrackModel } from '../../models/Track';
import type { MusicSourceConnector } from './MusicSourceConnector';
import { logger } from '../../utils/logger';

// ── Default CC download + store ───────────────────────────────────────────────

/**
 * Production implementation for the CC download→store pipeline.
 *
 * Downloads `external.downloadUrl`, uploads the audio buffer to S3 via
 * `uploadTrackAudio`, and sets `track.audioSource` so the ingest pipeline
 * can locate the source file. The follow-on `enqueueIngest` call then
 * transcodes the audio to encrypted HLS.
 */
async function defaultDownloadAndStore(
  external: ExternalTrack,
  trackId: string,
  _artistId: string,
): Promise<void> {
  if (!external.downloadUrl) {
    throw new Error(`importService: CC track ${external.externalId} has no downloadUrl`);
  }

  const response = await fetch(external.downloadUrl);
  if (!response.ok) {
    throw new Error(`importService: download failed ${response.status} for ${external.downloadUrl}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Set audioSource on the track so the ingest pipeline knows the S3 key
  const track = await TrackModel.findById(trackId);
  if (!track) throw new Error(`importService: track ${trackId} not found after upsert`);

  track.audioSource = { url: `/api/audio/${trackId}`, format: 'mp3' };
  await track.save();

  // Upload the raw MP3 to S3 — ingest will read it from there
  await uploadTrackAudio(track as Parameters<typeof uploadTrackAudio>[0], buffer);
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface ImportDeps {
  /**
   * CC only: downloads external.downloadUrl, sets track audioSource, uploads
   * the buffer to S3. Called before enqueueIngest so the ingest pipeline finds
   * the source at the track's S3 audio key.
   */
  downloadAndStore?: (external: ExternalTrack, trackId: string, artistId: string) => Promise<void>;

  /**
   * Fire-and-forget: enqueues the track for HLS transcoding + encryption.
   * Called after downloadAndStore for every CC track.
   */
  enqueueIngest?: (trackId: string) => void;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Run a full import from an external connector into the Syra catalog.
 *
 * Flow:
 *  1. Create an ImportJob (status: 'running').
 *  2. Call connector.search to fetch candidates.
 *  3. For each result: upsert artist + track; for CC, download + enqueue ingest.
 *  4. Persist final counts and status; return the job.
 *
 * Per-track failures are isolated — one bad track increments job.failed and
 * processing continues. A fatal search error (step 2) marks the job 'failed'.
 */
export async function runImport(
  connector: MusicSourceConnector,
  query: string,
  opts?: { limit?: number; deps?: ImportDeps },
): Promise<IImportJob> {
  const deps = opts?.deps ?? {};
  const downloadAndStore = deps.downloadAndStore ?? defaultDownloadAndStore;
  const enqueueIngest = deps.enqueueIngest ?? defaultEnqueueIngest;

  const job = await ImportJobModel.create({
    provider: connector.provider,
    query,
    status: 'running',
  });

  let results: ExternalTrack[];
  try {
    results = await connector.search(query, opts?.limit);
  } catch (err) {
    job.status = 'failed';
    job.error = String(err);
    await job.save();
    return job;
  }

  job.total = results.length;

  for (const external of results) {
    try {
      // Guard: at least one artist required for catalog upsert
      if (!external.artists.length) {
        job.skipped += 1;
        continue;
      }

      const { artist } = await upsertArtist(external.artists[0], connector.provider);
      const { track } = await upsertTrack(external, connector.provider);

      if (connector.provider === 'cc') {
        await downloadAndStore(external, track._id.toString(), artist._id.toString());
        enqueueIngest(track._id.toString());
      }
      // Audius: stream-only — no download or ingest needed; streamUrl is already on the track.

      job.imported += 1;
    } catch (err) {
      logger.error(`importService: per-track failure for ${external.externalId}:`, err);
      job.failed += 1;
    }
  }

  job.status = 'completed';
  await job.save();
  return job;
}
