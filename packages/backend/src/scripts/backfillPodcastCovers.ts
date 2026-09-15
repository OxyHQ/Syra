/**
 * One-shot: re-host the show cover for every RSS podcast still missing one.
 *
 * ## Why this exists
 *
 * `podcastImportService.importFeed` re-hosts the show's own cover into Syra S3
 * via `showCoverColumns`, but ONLY on a full parse. Its conditional-GET
 * short-circuit —
 *
 *   if (fetched.notModified && existing) {
 *     await setPodcastRefreshState(existing.id, { lastRefreshedAt: new Date(), needsDeepImport: false });
 *     return { podcast: existing, notModified: true, ... };
 *   }
 *
 * — returns immediately whenever the feed's ETag/Last-Modified still matches,
 * without ever re-checking whether `imageId` is still null. A show whose FIRST
 * full crawl failed to re-host its cover (a bad fetch, a transient error, or —
 * before this session's fixes — the `application/octet-stream` rejection
 * #142 fixed) is stuck with a null `imageId` forever after that: every
 * following refresh gets a 304 and never gets another chance. `toEpisodeDto`
 * and `toPodcastDto` read that null as "no cover of its own" and fall back to
 * whatever `imageSourceUrl` last held — for a podcast bootstrapped from a
 * directory candidate (`PodcastDirectory.ts`), that is the DIRECTORY's
 * thumbnail (Apple/PodcastIndex), not the show's actual, current RSS artwork.
 *
 * Found live, not in review: NUDE PROJECT PODCAST's own cover was an Apple
 * Podcasts directory thumbnail while its RSS feed had carried a different,
 * current image the whole time — invisible to every regular refresh because
 * they all got 304s. Measured before writing this: 84 of ~1,596 RSS podcasts
 * have `image_id is null`.
 *
 * This script forces exactly what a normal refresh withholds:
 * `importFeed(feedUrl, { force: true })` bypasses conditional GET so the feed
 * body is always re-parsed and `showCoverColumns` always gets to run. It
 * reuses `importFeed` rather than re-deriving a cover-only path — `importFeed`
 * is already the single, tested, idempotent mirror of one feed, covers
 * included, and re-running it upserts the same episodes it already has.
 *
 * ## Running it
 *
 *   bun run backfill:podcast-covers                  # against DATABASE_URL
 *   bun run backfill:podcast-covers -- --dry-run      # report what it would do
 *   bun run backfill:podcast-covers -- --limit 50     # a bounded first pass (shows)
 *   bun run backfill:podcast-covers -- --concurrency 8
 *
 * Idempotent by construction, the same shape as `backfillEpisodeImages.ts`:
 * the query that finds "still missing a cover" (`image_id is null`) finds
 * nothing once a show's cover is re-hosted, so re-running after an
 * interruption only touches what is still missing.
 */

import { and, asc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import dotenv from 'dotenv';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { podcasts } from '../db/schema/podcasts';
import { importFeed } from '../services/podcasts/podcastImportService';
import type { SafeFetchFn } from '../services/podcasts/RssConnector';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';

dotenv.config();

/** Keyset page size over `podcasts` — cheap per-row work, same as `backfillEpisodeImages.ts`. */
const BATCH_SIZE = 50;

/** Same default and rationale as `backfillEpisodeImages.ts`'s pool: one outbound fetch per show. */
const DEFAULT_CONCURRENCY = 4;

export interface PodcastCoverBackfillStats {
  podcastsScanned: number;
  /** `importFeed` re-hosted a cover: `imageId` went from null to set. */
  podcastsFixed: number;
  /** Forced re-parse still left `imageId` null — the feed genuinely has no show art. */
  podcastsNoArt: number;
  /** The feed could not be fetched or parsed this pass. */
  podcastsFailed: number;
}

export interface PodcastCoverBackfillOptions {
  dryRun?: boolean;
  /** Bounds the number of PODCASTS visited. */
  limit?: number;
  /** Podcasts processed at once. Defaults to `DEFAULT_CONCURRENCY`. */
  concurrency?: number;
  /** Injectable SSRF-safe fetch (defaults to the real `safeFetch`). For tests. */
  fetch?: SafeFetchFn;
}

interface CoverlessPodcast {
  id: string;
  feedUrl: string;
}

async function backfillOnePodcast(
  podcast: CoverlessPodcast,
  stats: PodcastCoverBackfillStats,
  options: PodcastCoverBackfillOptions
): Promise<void> {
  if (options.dryRun) {
    // A dry run cannot know whether the feed actually carries a cover without
    // fetching it — reporting "scanned" is the honest limit of what dry-run
    // can promise here, same as `backfillEpisodeImages.ts`'s own dry-run scope.
    return;
  }

  try {
    const result = await importFeed(podcast.feedUrl, { force: true, fetch: options.fetch });
    if (result.podcast.imageId) {
      stats.podcastsFixed += 1;
    } else {
      stats.podcastsNoArt += 1;
    }
  } catch (err) {
    stats.podcastsFailed += 1;
    logger.warn(`[backfill-podcast-covers] re-import failed for podcast ${podcast.id}`, {
      feedUrl: podcast.feedUrl,
      err: describeErrorSafely(err),
    });
  }
}

export async function backfillPodcastCovers(
  options: PodcastCoverBackfillOptions = {}
): Promise<PodcastCoverBackfillStats> {
  const stats: PodcastCoverBackfillStats = {
    podcastsScanned: 0,
    podcastsFixed: 0,
    podcastsNoArt: 0,
    podcastsFailed: 0,
  };
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  let lastId: string | undefined;

  for (;;) {
    if (options.limit !== undefined && stats.podcastsScanned >= options.limit) break;

    // Keyset on the primary key — `generatedId` mints uuid v7, so `id > $1`
    // walks the table once, same rationale as `backfillEpisodeImages.ts`.
    const batch = await getDb()
      .select({ id: podcasts.id, feedUrl: podcasts.feedUrl })
      .from(podcasts)
      .where(
        lastId === undefined
          ? and(eq(podcasts.source, 'rss'), isNull(podcasts.imageId), isNotNull(podcasts.feedUrl))
          : and(
              eq(podcasts.source, 'rss'),
              isNull(podcasts.imageId),
              isNotNull(podcasts.feedUrl),
              gt(podcasts.id, lastId)
            )
      )
      .orderBy(asc(podcasts.id))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;
    lastId = batch[batch.length - 1]?.id;

    const coverless = batch.filter((p): p is CoverlessPodcast => p.feedUrl !== null);

    const remaining = options.limit === undefined ? coverless.length : options.limit - stats.podcastsScanned;
    const queue = coverless.slice(0, Math.max(remaining, 0));

    async function worker(): Promise<void> {
      for (;;) {
        const podcast = queue.shift();
        if (podcast === undefined) return;
        stats.podcastsScanned += 1;
        await backfillOnePodcast(podcast, stats, options);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  return stats;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const limitFlag = process.argv.indexOf('--limit');

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

  const concurrencyFlag = process.argv.indexOf('--concurrency');
  let concurrency: number | undefined;
  if (concurrencyFlag !== -1) {
    concurrency = Number(process.argv[concurrencyFlag + 1]);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(
        `--concurrency needs a whole number of at least 1, got ${JSON.stringify(process.argv[concurrencyFlag + 1])}.`
      );
    }
  }

  await connectPostgres();
  logger.info(
    `[backfill-podcast-covers] starting${dryRun ? ' (dry run — nothing will be written)' : ''}` +
      `${limit !== undefined ? ` (limit ${limit} podcasts)` : ''}` +
      ` (concurrency ${concurrency ?? DEFAULT_CONCURRENCY})`
  );

  const stats = await backfillPodcastCovers({ dryRun, limit, concurrency });

  logger.info(
    `[backfill-podcast-covers] ${stats.podcastsScanned} podcast(s) scanned | ` +
      `${stats.podcastsFixed} cover(s) re-hosted | ${stats.podcastsNoArt} genuinely have no show art | ` +
      `${stats.podcastsFailed} feed failure(s)`
  );

  if (stats.podcastsFailed > 0) {
    logger.warn(
      `[backfill-podcast-covers] ${stats.podcastsFailed} feed(s) could not be re-imported this pass. ` +
        'Re-running retries only those — fixed shows are skipped.'
    );
  }
}

if (require.main === module) {
  main()
    .then(() => closePostgres())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[backfill-podcast-covers] fatal', { err: describeErrorSafely(err) });
      closePostgres().finally(() => process.exit(1));
    });
}
