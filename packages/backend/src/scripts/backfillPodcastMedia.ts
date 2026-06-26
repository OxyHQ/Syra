/**
 * One-shot, idempotent backfill: re-host external podcast/episode cover art into
 * Syra S3 and populate `imageSizes` + `primaryColor`/`secondaryColor` for shows
 * and episodes imported BEFORE media re-hosting existed (they only carry an
 * external artwork URL).
 *
 * Idempotent: a doc that already has re-hosted `imageSizes` is skipped. Safe to
 * re-run. The refresh scheduler also lazily re-hosts on each crawl, so this
 * script just accelerates the migration of the existing backlog.
 *
 * Iteration uses KEYSET PAGINATION by `_id` (short-lived `find().limit()` queries),
 * NOT a long-lived `.cursor()`: the per-doc re-host (download + sharp + S3) is slow,
 * which idle-times-out a server-side cursor (`CursorNotFound`, code 43) on big
 * collections. Each paginated query is independent, so the run can take as long as
 * it needs.
 *
 * Run: `bun run src/scripts/backfillPodcastMedia.ts` (or the `backfill:podcast-media`
 * package script) with the production MONGODB_URI in the environment.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { connectToDatabase } from '../utils/database';
import { logger } from '../utils/logger';
import { PodcastModel } from '../models/Podcast';
import { EpisodeModel } from '../models/Episode';
import { replaceColors } from '../services/catalog/entityColors';
import { rehostPodcastImage } from '../services/podcasts/podcastMedia';

dotenv.config();

const BATCH = 100;
const MEDIA_FIELDS = 'image imageSizes imageSourceUrl primaryColor secondaryColor';

export interface BackfillStats {
  processed: number;
  rehosted: number;
}

/** The external artwork URL to re-host: the stored fallback, or a legacy URL
 * that was written into `image` before re-hosting existed. */
function sourceImageUrl(doc: { image?: string; imageSourceUrl?: string }): string | undefined {
  if (doc.imageSourceUrl) return doc.imageSourceUrl;
  if (doc.image && !mongoose.Types.ObjectId.isValid(doc.image)) return doc.image;
  return undefined;
}

/** A doc needs backfill when it has a source URL but no re-hosted variants yet. */
function needsBackfill(doc: { image?: string; imageSizes?: { large?: unknown } | undefined; imageSourceUrl?: string }): boolean {
  return sourceImageUrl(doc) !== undefined && !doc.imageSizes?.large;
}

export async function backfillPodcasts(batchSize: number = BATCH): Promise<BackfillStats> {
  let processed = 0;
  let rehosted = 0;
  let lastId: mongoose.Types.ObjectId | undefined;

  for (;;) {
    const filter: Record<string, unknown> = { status: { $ne: 'removed' } };
    if (lastId) filter._id = { $gt: lastId };

    const batch = await PodcastModel.find(filter)
      .sort({ _id: 1 })
      .limit(batchSize)
      .select(`source podcastGuid feedUrl ${MEDIA_FIELDS}`);

    if (batch.length === 0) break;

    for (const podcast of batch) {
      if (!needsBackfill(podcast)) continue;
      const url = sourceImageUrl(podcast);
      if (!url) continue;
      processed += 1;

      try {
        const result = await rehostPodcastImage(url, {
          source: podcast.source,
          entityType: 'podcast',
          externalId: podcast.podcastGuid ?? podcast.feedUrl ?? podcast._id.toString(),
          existingImageId: podcast.image,
          existingImageSizes: podcast.imageSizes,
        });
        podcast.imageSourceUrl = url;
        if (result) {
          podcast.image = result.image;
          podcast.imageSizes = result.imageSizes;
          replaceColors(podcast, { primaryColor: result.primaryColor, secondaryColor: result.secondaryColor });
          rehosted += 1;
        }
        await podcast.save();
      } catch (err) {
        logger.warn('[backfill] podcast cover re-host failed', { podcastId: podcast._id.toString(), err });
      }

      if (processed % BATCH === 0) logger.info('[backfill] podcasts progress', { processed, rehosted });
    }

    lastId = batch[batch.length - 1]._id;
    if (batch.length < batchSize) break;
  }

  return { processed, rehosted };
}

export async function backfillEpisodes(batchSize: number = BATCH): Promise<BackfillStats> {
  let processed = 0;
  let rehosted = 0;
  let lastId: mongoose.Types.ObjectId | undefined;

  for (;;) {
    const filter: Record<string, unknown> = { status: { $ne: 'unavailable' } };
    if (lastId) filter._id = { $gt: lastId };

    const batch = await EpisodeModel.find(filter)
      .sort({ _id: 1 })
      .limit(batchSize)
      .select(`source guid ${MEDIA_FIELDS}`);

    if (batch.length === 0) break;

    for (const episode of batch) {
      // Only episodes that carry their OWN external artwork need backfill.
      if (!needsBackfill(episode)) continue;
      const url = sourceImageUrl(episode);
      if (!url) continue;
      processed += 1;

      try {
        const result = await rehostPodcastImage(url, {
          source: episode.source,
          entityType: 'episode',
          externalId: episode.guid,
          existingImageId: episode.image,
          existingImageSizes: episode.imageSizes,
        });
        episode.imageSourceUrl = url;
        if (result) {
          episode.image = result.image;
          episode.imageSizes = result.imageSizes;
          replaceColors(episode, { primaryColor: result.primaryColor, secondaryColor: result.secondaryColor });
          rehosted += 1;
        }
        await episode.save();
      } catch (err) {
        logger.warn('[backfill] episode cover re-host failed', { episodeId: episode._id.toString(), err });
      }

      if (processed % BATCH === 0) logger.info('[backfill] episodes progress', { processed, rehosted });
    }

    lastId = batch[batch.length - 1]._id;
    if (batch.length < batchSize) break;
  }

  return { processed, rehosted };
}

async function main(): Promise<void> {
  await connectToDatabase();
  logger.info('[backfill] starting podcast media backfill');

  const podcasts = await backfillPodcasts();
  const episodes = await backfillEpisodes();

  logger.info('[backfill] complete', {
    podcastsProcessed: podcasts.processed,
    podcastsRehosted: podcasts.rehosted,
    episodesProcessed: episodes.processed,
    episodesRehosted: episodes.rehosted,
  });
}

if (require.main === module) {
  main()
    .then(() => mongoose.connection.close())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[backfill] fatal error', { err });
      mongoose.connection.close().finally(() => process.exit(1));
    });
}
