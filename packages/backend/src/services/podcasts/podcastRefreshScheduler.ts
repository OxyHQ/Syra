/**
 * Podcast refresh scheduler — re-crawls active RSS feeds so mirrored episodes
 * stay current. Mirrors `startRecommendationScheduler`: a per-instance interval
 * guarded by a Redis distributed lock so exactly one instance per tick does the
 * work across the fleet. When Redis is unavailable the lock can't be taken and
 * the tick is skipped — safe, since conditional GET keeps a later crawl cheap.
 *
 * Feeds are prioritised by subscriber count then popularity, and each is only
 * refetched once its own `refreshIntervalMin` has elapsed. Per-feed failures are
 * isolated; one dead host never stalls the batch.
 */

import { withLock } from '../../utils/distributedLock';
import { logger } from '../../utils/logger';
import { PodcastModel } from '../../models/Podcast';
import { importFeed } from './podcastImportService';

/** How often the refresh tick fires on each instance. */
const TICK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
/** First tick is delayed so it never competes with cold-start boot work. */
const INITIAL_DELAY_MS = 90 * 1000;
/** Lock TTL must comfortably exceed a worst-case batch duration. */
const REFRESH_LOCK_TTL_MS = 10 * 60 * 1000;
/** Maximum feeds refreshed per tick to bound work and outbound load. */
const BATCH_SIZE = 50;

let started = false;
let timer: NodeJS.Timeout | null = null;
let running = false;

function isDue(lastRefreshedAt: Date | undefined, refreshIntervalMin: number): boolean {
  if (!lastRefreshedAt) return true;
  const elapsedMs = Date.now() - lastRefreshedAt.getTime();
  return elapsedMs >= refreshIntervalMin * 60 * 1000;
}

async function refreshBatch(): Promise<void> {
  const candidates = await PodcastModel.find({ source: 'rss', status: 'active' })
    .sort({ subscriberCount: -1, popularity: -1 })
    .limit(BATCH_SIZE)
    .select('feedUrl lastRefreshedAt refreshIntervalMin')
    .lean();

  for (const candidate of candidates) {
    if (!candidate.feedUrl) continue;
    if (!isDue(candidate.lastRefreshedAt, candidate.refreshIntervalMin)) continue;

    try {
      await importFeed(candidate.feedUrl);
    } catch (err) {
      logger.warn('[podcasts] refresh failed for feed', { feedUrl: candidate.feedUrl, err });
    }
  }
}

async function tick(): Promise<void> {
  if (running) return; // never overlap on the same instance
  running = true;
  try {
    await withLock('podcasts:refresh', REFRESH_LOCK_TTL_MS, async () => {
      try {
        await refreshBatch();
      } catch (err) {
        logger.warn('[podcasts] refresh batch failed', { err });
      }
    });
  } finally {
    running = false;
  }
}

/**
 * Start the podcast refresh scheduler. Idempotent: calling twice is a no-op.
 * The first tick is delayed; subsequent ticks fire on a fixed interval.
 */
export function startPodcastRefreshScheduler(): void {
  if (started) return;
  started = true;

  setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }, INITIAL_DELAY_MS).unref?.();

  logger.info('[podcasts] refresh scheduler started', { intervalMinutes: TICK_INTERVAL_MS / 60000 });
}

/** Stop the scheduler (used in tests / graceful shutdown). */
export function stopPodcastRefreshScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}
