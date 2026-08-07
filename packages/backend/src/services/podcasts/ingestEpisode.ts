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
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { findEpisodeById, setEpisodeHls, setEpisodeStatus } from '../../db/podcasts/episodes';
import type { EpisodeRow } from '../../db/podcasts/serialize';
import { logger } from '../../utils/logger';
import { getS3HlsKey, getS3PodcastEpisodeAudioKey } from '../../config/s3.config';
import { streamFromS3 } from '../s3Service';
import { packageToEncryptedHls } from '../ingest/hlsPackager';
import type { PackageOptions, PackageResult } from '../ingest/hlsPackager';
import { storePackagedHls } from '../ingest/hlsStorage';
import type { StoreHlsTarget, StoredHls } from '../ingest/hlsStorage';
import { buildStreamKeyUriFor } from '../ingest/streamKeyUri';

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
  const episode = await findEpisodeById(episodeId);
  if (!episode) {
    throw new Error(`ingestEpisode: episode not found: ${episodeId}`);
  }

  if (!episode.audioSourceUrl || !episode.audioSourceFormat) {
    await setEpisodeStatus(episodeId, 'failed').catch((saveErr) =>
      logger.error('[podcasts] failed to persist failed episode status', { episodeId, err: saveErr }),
    );
    throw new Error(`ingestEpisode: no source audio for episode ${episodeId}`);
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
    logger.error('[podcasts] episode ingest failed', { episodeId, err });
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
    logger.error('[podcasts] episode ingest enqueue failed', { episodeId, err }),
  );
}
