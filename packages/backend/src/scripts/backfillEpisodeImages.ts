/**
 * One-shot: mirror the per-episode cover art the RSS import's own retry never
 * reached, for the shows that were already crawled before that retry existed.
 *
 * ## Why this exists
 *
 * `podcastImportService.importFeed` re-hosts an episode's own `<itunes:image>`
 * (distinct from the show's) bounded by `MAX_EPISODE_IMAGE_REHOST` per crawl,
 * and — as of the fix this script ships beside — retries an EXISTING episode
 * whose `imageId` is still null on every later crawl. That closes the leak
 * going forward, but does nothing for episodes already stuck: any show with a
 * back-catalogue bigger than the per-crawl cap, or crawled before the retry
 * landed at all, has episodes sitting on `imageId = null` today. `toEpisodeDto`
 * (`db/podcasts/serialize.ts`) reads that as "no cover of its own" and falls
 * back to the SHOW's artwork, which is indistinguishable in the app from
 * "episode covers are not being copied" — the bug report this script answers.
 *
 * This script re-crawls the feed of every RSS show that has at least one such
 * episode, matches episodes by `guid`, and re-hosts exactly the ones still
 * missing `imageId` — the same predicate the ongoing import now retries, run
 * once, eagerly, without waiting for the refresh schedule.
 *
 * ## Running it
 *
 *   bun run backfill:episode-images                  # against DATABASE_URL
 *   bun run backfill:episode-images -- --dry-run     # report what it would do
 *   bun run backfill:episode-images -- --limit 50    # a bounded first pass (shows)
 *
 * It re-fetches one feed per affected show and re-hosts one image per affected
 * episode, so it is long-running on a large catalogue and WILL be interrupted.
 * That is expected: re-running finds exactly the episodes still missing
 * `imageId` — the table is the checkpoint, same as `backfillTrackFingerprints`.
 */

import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import dotenv from 'dotenv';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { updateEpisode } from '../db/podcasts/episodes';
import { episodes, podcasts } from '../db/schema/podcasts';
import { fetchAndParse, type ParsedEpisode, type SafeFetchFn } from '../services/podcasts/RssConnector';
import { rehostPodcastImage } from '../services/podcasts/podcastMedia';
import { artworkColumns } from '../services/podcasts/podcastImportService';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';

dotenv.config();

/** Keyset page size over `podcasts` — cheap per-row work, unlike the fingerprints backfill. */
const BATCH_SIZE = 50;

export interface BackfillStats {
  podcastsScanned: number;
  /** Already had no episode missing its own cover — nothing to do. */
  podcastsSkipped: number;
  /** The feed could not be fetched or parsed this pass. */
  podcastsFailed: number;
  episodesScanned: number;
  episodesFixed: number;
  /** The feed item has no `<itunes:image>` of its own, or it matches the show's. */
  episodesNoDistinctArt: number;
  /** The feed no longer lists this guid at all. */
  episodesGoneFromFeed: number;
  /** A distinct URL was found but the mirror could not fetch/process it. */
  episodesFailed: number;
}

export interface BackfillOptions {
  dryRun?: boolean;
  /** Bounds the number of PODCASTS visited, not episodes. */
  limit?: number;
  /** Injectable SSRF-safe fetch (defaults to the real `safeFetch`). For tests. */
  fetch?: SafeFetchFn;
}

/** A podcast row as this script needs it. */
interface BackfillPodcast {
  id: string;
  feedUrl: string | null;
}

/** An episode missing its own cover, as this script needs it. */
interface MissingArtEpisode {
  id: string;
  guid: string;
}

async function findEpisodesMissingArt(podcastId: string): Promise<MissingArtEpisode[]> {
  return getDb()
    .select({ id: episodes.id, guid: episodes.guid })
    .from(episodes)
    .where(and(eq(episodes.podcastId, podcastId), isNull(episodes.imageId)));
}

/**
 * Re-host ONE episode's own art, matched out of the freshly parsed feed by
 * guid. Isolated per episode, like the import loop: one bad image must not
 * abort the rest of the show.
 */
async function backfillOneEpisode(
  episode: MissingArtEpisode,
  parsed: ParsedEpisode | undefined,
  showImageUrl: string | undefined,
  stats: BackfillStats,
  options: BackfillOptions
): Promise<void> {
  stats.episodesScanned += 1;

  if (!parsed) {
    stats.episodesGoneFromFeed += 1;
    return;
  }

  const ownArtUrl = parsed.image;
  if (!ownArtUrl || ownArtUrl === showImageUrl) {
    stats.episodesNoDistinctArt += 1;
    return;
  }

  if (options.dryRun) {
    stats.episodesFixed += 1;
    return;
  }

  try {
    const rehosted = await rehostPodcastImage(ownArtUrl, {
      source: 'rss',
      entityType: 'episode',
      externalId: episode.guid,
    });

    if (!rehosted) {
      stats.episodesFailed += 1;
      // Keep the raw URL as a visible fallback and a cheaper next attempt —
      // exactly what the import path does on a failed re-host.
      await updateEpisode(episode.id, { imageSourceUrl: ownArtUrl });
      return;
    }

    await updateEpisode(episode.id, {
      ...artworkColumns(rehosted.image, rehosted.imageSizes),
      primaryColor: rehosted.primaryColor ?? null,
      secondaryColor: rehosted.secondaryColor ?? null,
      imageSourceUrl: ownArtUrl,
    });
    stats.episodesFixed += 1;
  } catch (err) {
    stats.episodesFailed += 1;
    logger.warn(`[backfill-episode-images] re-host failed for episode ${episode.id}`, {
      err: describeErrorSafely(err),
    });
  }
}

async function backfillOnePodcast(
  podcast: BackfillPodcast,
  stats: BackfillStats,
  options: BackfillOptions
): Promise<void> {
  if (!podcast.feedUrl) {
    // An `rss` show with no feed url is not representable in steady state, but
    // this script must never crash on data it did not create.
    stats.podcastsFailed += 1;
    logger.warn(`[backfill-episode-images] rss podcast ${podcast.id} has no feed_url`);
    return;
  }

  const missing = await findEpisodesMissingArt(podcast.id);
  if (missing.length === 0) {
    stats.podcastsSkipped += 1;
    return;
  }

  let fetched;
  try {
    // No conditional-GET headers: this pass needs the current body regardless
    // of what the last regular crawl's `etag` says.
    fetched = await fetchAndParse(podcast.feedUrl, {}, { fetch: options.fetch });
  } catch (err) {
    stats.podcastsFailed += 1;
    logger.warn(`[backfill-episode-images] could not fetch feed for podcast ${podcast.id}`, {
      feedUrl: podcast.feedUrl,
      err: describeErrorSafely(err),
    });
    return;
  }

  if (!fetched.episodes) {
    stats.podcastsFailed += 1;
    logger.warn(`[backfill-episode-images] empty parse for podcast ${podcast.id}`, {
      feedUrl: podcast.feedUrl,
    });
    return;
  }

  const byGuid = new Map(fetched.episodes.map((ep) => [ep.guid, ep]));
  const showImageUrl = fetched.show?.image;

  for (const episode of missing) {
    await backfillOneEpisode(episode, byGuid.get(episode.guid), showImageUrl, stats, options);
  }
}

export async function backfillEpisodeImages(options: BackfillOptions = {}): Promise<BackfillStats> {
  const stats: BackfillStats = {
    podcastsScanned: 0,
    podcastsSkipped: 0,
    podcastsFailed: 0,
    episodesScanned: 0,
    episodesFixed: 0,
    episodesNoDistinctArt: 0,
    episodesGoneFromFeed: 0,
    episodesFailed: 0,
  };
  let lastId: string | undefined;

  for (;;) {
    if (options.limit !== undefined && stats.podcastsScanned >= options.limit) break;

    // Keyset on the primary key, same rationale as `backfillTrackFingerprints`:
    // `generatedId` mints uuid v7, so `id > $1` walks the table once.
    const batch = await getDb()
      .select({ id: podcasts.id, feedUrl: podcasts.feedUrl })
      .from(podcasts)
      .where(
        lastId === undefined
          ? eq(podcasts.source, 'rss')
          : and(eq(podcasts.source, 'rss'), gt(podcasts.id, lastId))
      )
      .orderBy(asc(podcasts.id))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    for (const podcast of batch) {
      if (options.limit !== undefined && stats.podcastsScanned >= options.limit) break;
      stats.podcastsScanned += 1;
      await backfillOnePodcast(podcast, stats, options);
    }

    lastId = batch[batch.length - 1]?.id;
  }

  return stats;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const limitFlag = process.argv.indexOf('--limit');

  // Same refusal as `backfillTrackFingerprints`: an unparseable `--limit`
  // silently becoming "no limit" is the opposite of what typing it asked for.
  let limit: number | undefined;
  if (limitFlag !== -1) {
    limit = Number(process.argv[limitFlag + 1]);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error(
        `--limit needs a non-negative whole number, got ${JSON.stringify(process.argv[limitFlag + 1])}. ` +
          'Refusing to run: an unparseable limit would otherwise mean no limit at all.'
      );
    }
  }

  await connectPostgres();
  logger.info(
    `[backfill-episode-images] starting${dryRun ? ' (dry run — nothing will be written)' : ''}` +
      `${limit !== undefined ? ` (limit ${limit} podcasts)` : ''}`
  );

  const stats = await backfillEpisodeImages({ dryRun, limit });

  logger.info(
    `[backfill-episode-images] ${stats.podcastsScanned} podcasts scanned | ` +
      `${stats.podcastsSkipped} already complete | ${stats.podcastsFailed} feed failures | ` +
      `${stats.episodesScanned} episodes scanned | ${stats.episodesFixed} fixed | ` +
      `${stats.episodesNoDistinctArt} had no distinct art | ` +
      `${stats.episodesGoneFromFeed} gone from the feed | ${stats.episodesFailed} re-host failures`
  );

  if (stats.episodesFailed > 0 || stats.podcastsFailed > 0) {
    logger.warn(
      `[backfill-episode-images] ${stats.episodesFailed} episode(s) and ${stats.podcastsFailed} ` +
        'feed(s) could not be fixed this pass. Re-running retries only those — fixed episodes and ' +
        'completed shows are skipped.'
    );
  }
}

if (require.main === module) {
  main()
    .then(() => closePostgres())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[backfill-episode-images] fatal', { err: describeErrorSafely(err) });
      closePostgres().finally(() => process.exit(1));
    });
}
