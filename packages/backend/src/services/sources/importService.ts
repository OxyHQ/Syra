import type { ExternalTrack } from '@syra/shared-types';
import { ImportJobModel, IImportJob } from '../../models/ImportJob';
import { upsertArtist } from '../catalog/upsertArtist';
import { upsertTrack } from '../catalog/upsertTrack';
import { enqueueIngest as defaultEnqueueIngest } from '../ingest/ingestTrack';
import { uploadTrackAudio } from '../audioStorageService';
import { TrackModel } from '../../models/Track';
import { toApiFormat } from '../../utils/musicHelpers';
import type { MusicSourceConnector } from './MusicSourceConnector';
import { logger } from '../../utils/logger';
import { assertSafeAudioUrl, isLikelyAudio, MAX_AUDIO_BYTES } from './safeAudioDownload';

// ── Default CC download + store ───────────────────────────────────────────────

/**
 * Production implementation for the CC download→store pipeline.
 *
 * Security hardening applied (per OWASP SSRF + resource-exhaustion guidance):
 *  1. SSRF guard — `assertSafeAudioUrl` rejects private IPs, localhost, file://
 *     and over-length URLs before any network call is made.
 *  2. Redirect rejection — fetched with `redirect: 'manual'`; any 3xx response
 *     is rejected immediately to prevent a redirect from pointing to an internal
 *     host that bypassed the pre-fetch URL check.
 *  3. Content-Length cap — if the server advertises a body larger than
 *     MAX_AUDIO_BYTES (100 MB) the download is aborted before reading a byte.
 *  4. Streaming size cap — body is read chunk-by-chunk; the running byte count
 *     is checked after every chunk so memory is bounded even when the server
 *     omits or lies about content-length.
 *  5. Audio sniff — after buffering, `isLikelyAudio` rejects responses whose
 *     magic bytes and content-type don't look like real audio.
 *
 * A failure at any step throws, which the runImport per-track try/catch
 * catches → increments job.failed → continues with the next track.
 */
async function defaultDownloadAndStore(
  external: ExternalTrack,
  trackId: string,
  _artistId: string,
): Promise<void> {
  if (!external.downloadUrl) {
    throw new Error(`importService: CC track ${external.externalId} has no downloadUrl`);
  }

  // 1. SSRF guard — throws for unsafe URLs
  assertSafeAudioUrl(external.downloadUrl);

  // 2. Fetch without following redirects
  const response = await fetch(external.downloadUrl, { redirect: 'manual' });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `importService: redirect not allowed for CC download (${response.status}) — possible SSRF via redirect`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `importService: download failed ${response.status} for ${external.downloadUrl}`,
    );
  }

  // 3. Content-Length pre-check
  const clHeader = response.headers.get('content-length');
  if (clHeader !== null) {
    const declared = Number(clHeader);
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
      throw new Error(
        `importService: content-length ${declared} exceeds MAX_AUDIO_BYTES ${MAX_AUDIO_BYTES}`,
      );
    }
  }

  // 4. Streaming read with hard byte cap
  if (!response.body) {
    throw new Error('importService: response has no body');
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_AUDIO_BYTES) {
      await reader.cancel();
      throw new Error(`importService: audio too large (> ${MAX_AUDIO_BYTES} bytes)`);
    }
    chunks.push(value);
  }

  const buffer = Buffer.concat(chunks);

  // 5. Content-type / magic-byte check
  const contentType = response.headers.get('content-type');
  if (!isLikelyAudio(buffer, contentType)) {
    throw new Error(
      `importService: response does not appear to be audio (content-type: ${contentType ?? 'none'})`,
    );
  }

  // Set audioSource on the track so the ingest pipeline knows the S3 key
  const track = await TrackModel.findById(trackId);
  if (!track) throw new Error(`importService: track ${trackId} not found after upsert`);

  track.audioSource = { url: `/api/audio/${trackId}`, format: 'mp3' };
  await track.save();

  // Upload the raw MP3 to S3 — ingest will read it from there
  const trackForUpload = toApiFormat(track);
  if (!trackForUpload) {
    throw new Error(`importService: failed to serialize track ${trackId} for upload`);
  }
  await uploadTrackAudio(trackForUpload, buffer);
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
