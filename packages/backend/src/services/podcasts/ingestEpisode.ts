/**
 * Episode HLS ingest — the Syra-hosted (creator-uploaded) counterpart of
 * `services/ingest/ingestTrack`. It REUSES the shared encryption/packaging
 * primitives (`packageToEncryptedHls`, `storePackagedHls`, `buildStreamKeyUriFor`)
 * rather than duplicating them; only the entity-specific orchestration (load the
 * `Episode`, fetch its source audio from S3, write back hls/status) lives here.
 *
 * `storePackagedHls` is invoked with `recordId: episodeId` and a key builder over
 * `getS3HlsKey(podcastId, episodeId, …)`, so the AES key is stored in `TrackKey`
 * keyed by the episode id and HLS files land under `hls/<podcastId>/<episodeId>/…`
 * — the same key store the episode stream `/key` endpoint reads.
 *
 * Status transitions: processing (on enqueue) → ready (success) | failed (error).
 *
 * ## A PRIVATE show is not transcoded, and that is a security decision
 *
 * An HLS variant playlist hands the player a presigned S3 URL per segment,
 * valid for `SEGMENT_URL_TTL_SEC` (`services/stream/manifestService.ts`) with no
 * auth of its own — that is what makes the ladder fast, and it is also what
 * makes it unrevocable. Once a segment URL is out, six hours of access exist
 * that no change to `podcasts.visibility` can withdraw.
 *
 * For a public or unlisted show that is the intended trade: the manifest is
 * gated, the segments are short-lived, and the content is meant to be heard. For
 * a PRIVATE show it is not a trade at all, so the ladder is never built. A
 * private show's episodes stay on the progressive `/audio` path, which is
 * checked per request against the show's current visibility.
 *
 * The deferral is undone by publishing: `updatePodcast` calls
 * {@link enqueueDeferredEpisodeIngests} on a real `private` -> not-private
 * transition, which finds the skipped episodes by their missing
 * `hls_master_key` — `findEpisodeIdsAwaitingHls` (`db/podcasts/episodes.ts`)
 * keys on that column and on `audio_source_url`, and admits every status but
 * `unavailable`.
 *
 * ## The deferral still finishes the episode
 *
 * This file used to leave `status` untouched, on the argument that an episode
 * left `ready` would leave nothing for the publish transition to find. That
 * argument was false — the transition finds episodes by `hls_master_key`, as the
 * paragraph above says — and the cost of it was measured in production: a
 * private show's episodes sat at `processing` with their MP3s in S3, fully
 * playable through `/audio` and reported as unfinished by every reader that asks
 * `status`.
 *
 * So a deferral is a COMPLETED ingest for everything a private show can have:
 * the source audio landed, the progressive path serves it, and the ladder is the
 * only thing missing. `status` becomes `ready` with `hls_master_key` still NULL,
 * which is precisely the pair the transition looks for.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import {
  findEpisodeById,
  findEpisodeIdsAwaitingHls,
  setEpisodeHls,
  setEpisodeStatus,
} from '../../db/podcasts/episodes';
import type { EpisodeRow } from '../../db/podcasts/serialize';
import { logger } from '../../utils/logger';
import { getS3HlsKey, getS3PodcastEpisodeAudioKey } from '../../config/s3.config';
import { streamFromS3 } from '../s3Service';
import { packageToEncryptedHls } from '../ingest/hlsPackager';
import type { PackageOptions, PackageResult } from '../ingest/hlsPackager';
import { storePackagedHls } from '../ingest/hlsStorage';
import type { StoreHlsTarget, StoredHls } from '../ingest/hlsStorage';
import { buildStreamKeyUriFor } from '../ingest/streamKeyUri';
import { describeErrorSafely } from '../../utils/error';

export interface EpisodeFetchSourceResult {
  localPath: string;
  cleanup: () => void;
}

export interface IngestEpisodeDeps {
  fetchSource?: (episode: EpisodeRow) => Promise<EpisodeFetchSourceResult>;
  packageHls?: (opts: PackageOptions) => Promise<PackageResult>;
  storeHls?: (result: PackageResult, target: StoreHlsTarget) => Promise<StoredHls>;
  keyUri?: string;
}

// ── Default fetchSource: stream the uploaded source from S3 to a temp file ─────

async function defaultFetchSource(episode: EpisodeRow): Promise<EpisodeFetchSourceResult> {
  // `audioSource` was one optional subdocument; `schema/podcasts.ts` flattened
  // it onto four nullable columns, and `format` is the one the S3 key needs.
  if (!episode.audioSourceFormat) {
    throw new Error(`ingestEpisode: no source audio for episode ${episode.id}`);
  }

  const s3Key = getS3PodcastEpisodeAudioKey(
    episode.id,
    episode.podcastId,
    episode.audioSourceFormat,
  );
  const { stream } = await streamFromS3(s3Key);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-src-'));
  const localPath = path.join(tmpDir, `source.${episode.audioSourceFormat}`);

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

// ── Main job ───────────────────────────────────────────────────────────────────

export async function ingestEpisode(episodeId: string, deps?: IngestEpisodeDeps): Promise<void> {
  const found = await findEpisodeById(episodeId);
  if (!found) {
    throw new Error(`ingestEpisode: episode not found: ${episodeId}`);
  }
  const { episode, show } = found;

  /**
   * Checked BEFORE the private-show branch below, because that branch's whole
   * claim is "the audio landed, only the ladder is missing" — and it can only
   * make that claim about an episode that HAS source audio. Ordered the other
   * way round, a private show's drafted-but-never-ingested episode would be
   * marked `ready` with nothing to play.
   */
  if (!episode.audioSourceUrl || !episode.audioSourceFormat) {
    await setEpisodeStatus(episodeId, 'failed').catch((saveErr) =>
      logger.error('[podcasts] failed to persist failed episode status', { episodeId, err: saveErr }),
    );
    throw new Error(`ingestEpisode: no source audio for episode ${episodeId}`);
  }

  /**
   * The private-show deferral — see the file header for why no ladder is built.
   *
   * `ready`, NOT `processing` and not `failed`. Nothing failed, and nothing is
   * still running either: for a private show this episode is as finished as it
   * can be, and it is already playable on the progressive `/audio` path. The
   * publish transition still finds it, because `findEpisodeIdsAwaitingHls`
   * selects on `hls_master_key is null` — which this leaves alone — rather than
   * on `status`.
   */
  if (show.visibility === 'private') {
    logger.info('[podcasts] episode ingest deferred: show is private', {
      episodeId,
      podcastId: show.id,
    });
    await setEpisodeStatus(episodeId, 'ready');
    return;
  }

  await setEpisodeStatus(episodeId, 'processing');

  const fetchSource = deps?.fetchSource ?? defaultFetchSource;
  const packageHls = deps?.packageHls ?? packageToEncryptedHls;
  const doStoreHls = deps?.storeHls ?? storePackagedHls;
  const keyUri = deps?.keyUri ?? buildStreamKeyUriFor(`/api/podcasts/episodes/${episodeId}`);

  let cleanup: (() => void) | undefined;
  let outputDir: string | undefined;

  try {
    const fetched = await fetchSource(episode);
    cleanup = fetched.cleanup;

    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-hls-'));
    const result = await packageHls({ inputPath: fetched.localPath, outputDir, keyUri });

    // Episodes keep their existing `hls/{podcastId}/{episodeId}/…` layout — the
    // key builder is now supplied per caller, so this is the same output as before.
    const stored = await doStoreHls(result, {
      kind: 'episode',
      recordId: episodeId,
      buildKey: (relPath) => getS3HlsKey(episode.podcastId, episodeId, relPath),
    });

    // The ladder is `episode_hls_renditions` now, so the master key and the
    // rendition rows are two statements — written in ONE transaction, together
    // with the `ready` status, because an episode advertising a master playlist
    // whose variants never landed is a 404 mid-playback.
    await setEpisodeHls(episodeId, stored.hlsMasterKey, stored.hls);
  } catch (err) {
    await setEpisodeStatus(episodeId, 'failed').catch((saveErr) =>
      logger.error('[podcasts] failed to persist failed episode status', { episodeId, err: saveErr }),
    );
    logger.error('[podcasts] episode ingest failed', { episodeId, err: describeErrorSafely(err) });
    throw err;
  } finally {
    cleanup?.();
    if (outputDir) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
}

// ── Fire-and-forget enqueue seam (mirrors enqueueIngest) ───────────────────────

export function enqueueEpisodeIngest(episodeId: string): void {
  ingestEpisode(episodeId).catch((err) =>
    logger.error('[podcasts] episode ingest enqueue failed', { episodeId, err: describeErrorSafely(err) }),
  );
}

/**
 * Enqueue the transcodes a show deferred while it was private.
 *
 * Awaited only for the LOOKUP — each ingest itself is fire-and-forget through
 * {@link enqueueEpisodeIngest}, so publishing a show with a long back catalogue
 * answers immediately instead of blocking the PATCH on ffmpeg.
 */
export async function enqueueDeferredEpisodeIngests(podcastId: string): Promise<void> {
  const episodeIds = await findEpisodeIdsAwaitingHls(podcastId);
  if (episodeIds.length === 0) return;

  logger.info('[podcasts] enqueuing deferred episode ingests', {
    podcastId,
    episodes: episodeIds.length,
  });
  for (const episodeId of episodeIds) enqueueEpisodeIngest(episodeId);
}
