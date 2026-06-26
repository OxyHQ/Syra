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

async function backfillPodcasts(): Promise<{ processed: number; rehosted: number }> {
  let processed = 0;
  let rehosted = 0;

  const cursor = PodcastModel.find({ status: { $ne: 'removed' } })
    .select('source podcastGuid feedUrl image imageSizes imageSourceUrl primaryColor secondaryColor')
    .cursor();

  for await (const podcast of cursor) {
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

  return { processed, rehosted };
}

async function backfillEpisodes(): Promise<{ processed: number; rehosted: number }> {
  let processed = 0;
  let rehosted = 0;

  // Only episodes that carry their OWN external artwork need backfill.
  const cursor = EpisodeModel.find({ status: { $ne: 'unavailable' } })
    .select('source guid image imageSizes imageSourceUrl primaryColor secondaryColor')
    .cursor();

  for await (const episode of cursor) {
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
