/**
 * Podcast search enrichment — fast SHALLOW upsert (instant results) + background
 * DEEP import (feed → episodes + re-hosted cover + primaryColor).
 *
 * On a podcast search we:
 *  1. Hit the directories (`searchPodcasts`: Podcast Index + Apple) once per
 *     query (TTL-throttled), bounded by a hard timeout so it can NEVER hang the
 *     request — replacing the old multi-minute import-on-tap.
 *  2. Immediately `bulkWrite` a SHALLOW Podcast doc per candidate from the data
 *     the directory already returns (title/author/feedUrl/podcastGuid/external
 *     image) — NO feed fetch. These get real ids and appear in the SAME search
 *     response. Existing shows are REFRESHED (title/author/image) so a changed
 *     photo/title propagates; they are never permanently skipped.
 *  3. Enqueue the heavy DEEP import in the BACKGROUND (serialized, one feed at a
 *     time = natural rate limit) ONLY for shows that are new (`needsDeepImport`)
 *     or stale (feed not re-fetched within {@link DEEP_REFRESH_STALE_MS}).
 *
 * Caps: ≤{@link MAX_FEEDS_PER_SEARCH} candidates/search; dedup vs in-flight feed;
 * per-query TTL throttle; env kill-switch `PODCAST_BULK_IMPORT_ENABLED=false`.
 */

import { PodcastModel } from '../../models/Podcast';
import { logger } from '../../utils/logger';
import { searchPodcasts as directorySearch, type PodcastDirectoryCandidate } from './PodcastDirectory';
import { importFeed } from './podcastImportService';

/** Minimum gap between directory syncs for the same normalized query (10 min). */
const SEARCH_IMPORT_TTL_MS = 10 * 60 * 1000;

/** Max directory candidates handled per search (cost + rate cap). */
export const MAX_FEEDS_PER_SEARCH = 25;

/** Hard timeout on the in-request directory call so a search can never hang. */
const DIRECTORY_TIMEOUT_MS = 3000;

/** Global backpressure for expensive deep imports queued from search. */
export const MAX_DEEP_IMPORT_QUEUE_SIZE = 100;

/** Re-pull a show's full feed at most this often from search (24h). */
const DEEP_REFRESH_STALE_MS = 24 * 60 * 60 * 1000;

const lastSyncAt = new Map<string, number>();
const queuedFeeds = new Set<string>();
let importQueue: Promise<void> = Promise.resolve();

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function bulkImportEnabled(): boolean {
  return process.env.PODCAST_BULK_IMPORT_ENABLED !== 'false';
}

function definedOnly(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Resolve a promise to a fallback if it doesn't settle within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Shallow upsert (instant results) ────────────────────────────────────────────

/**
 * Upsert a SHALLOW Podcast doc per directory candidate (metadata only, no feed
 * fetch). Refreshes existing shows' directory metadata; flags new docs for deep
 * import. Best-effort; a bulk error (e.g. a rare duplicate podcastGuid) never
 * throws into the caller.
 */
export async function shallowUpsertCandidates(candidates: PodcastDirectoryCandidate[]): Promise<void> {
  if (candidates.length === 0) return;

  const ops = candidates.map((candidate) => ({
    updateOne: {
      filter: { feedUrl: candidate.feedUrl },
      update: {
        // Refresh directory-owned metadata on every sync. `image` (the Syra id)
        // is owned by the deep re-host step and is never touched here; the
        // external artwork URL lives in `imageSourceUrl` for instant display.
        $set: definedOnly({
          title: candidate.title,
          author: candidate.author,
          imageSourceUrl: candidate.image,
          ...(candidate.categories.length > 0 ? { categories: candidate.categories } : {}),
        }),
        // Stable identity + flags set once, on insert.
        $setOnInsert: definedOnly({
          source: 'rss',
          status: 'active',
          claimable: true,
          needsDeepImport: true,
          podcastGuid: candidate.podcastGuid,
          podcastIndexId: candidate.podcastIndexId,
          appleCollectionId: candidate.appleCollectionId,
        }),
      },
      upsert: true,
    },
  }));

  try {
    await PodcastModel.bulkWrite(ops, { ordered: false });
  } catch (err) {
    logger.warn('[podcast-import] shallow upsert bulkWrite partial failure', { err });
  }
}

// ── Deep import (background) ─────────────────────────────────────────────────────

/**
 * Enqueue a SINGLE feed's deep import onto the serialized background queue.
 * Deduped by in-flight feedUrl. Fire-and-forget; never throws.
 */
export function enqueuePodcastImport(feedUrl: string, directory?: PodcastDirectoryCandidate): boolean {
  const key = feedUrl.trim().toLowerCase();
  if (!key) return false;
  if (queuedFeeds.has(key)) return false;
  if (queuedFeeds.size >= MAX_DEEP_IMPORT_QUEUE_SIZE) {
    logger.warn('[podcast-import] deep import queue full; dropping feed import', {
      feedUrl,
      queueSize: queuedFeeds.size,
      maxQueueSize: MAX_DEEP_IMPORT_QUEUE_SIZE,
    });
    return false;
  }
  queuedFeeds.add(key);

  importQueue = importQueue
    .catch(() => {
      // Keep the queue alive after a previous fire-and-forget failure.
    })
    .then(async () => {
      try {
        await importFeed(feedUrl, directory ? { directory } : {});
      } catch (err) {
        logger.warn('[podcast-import] deep feed import failed', { feedUrl, err });
      } finally {
        queuedFeeds.delete(key);
      }
    });

  return true;
}

/**
 * Among the just-upserted candidate feeds, enqueue a deep import only for those
 * that are new (`needsDeepImport`) or stale (feed not re-fetched recently).
 * Already-fresh shows are NOT re-pulled, so search never re-fetches a 15MB feed
 * on every keystroke.
 */
async function enqueueDeepImports(
  candidates: PodcastDirectoryCandidate[],
  enqueue: (feedUrl: string, directory?: PodcastDirectoryCandidate) => boolean | void,
  now: number,
): Promise<number> {
  const feedUrls = candidates.map((c) => c.feedUrl);
  const staleBefore = new Date(now - DEEP_REFRESH_STALE_MS);

  const targets = await PodcastModel.find({
    feedUrl: { $in: feedUrls },
    $or: [
      { needsDeepImport: true },
      { lastRefreshedAt: { $exists: false } },
      { lastRefreshedAt: { $lt: staleBefore } },
    ],
  })
    .select('feedUrl')
    .lean();

  const byFeedUrl = new Map(candidates.map((c) => [c.feedUrl, c]));
  let enqueued = 0;
  for (const target of targets) {
    if (!target.feedUrl) continue;
    if (enqueue(target.feedUrl, byFeedUrl.get(target.feedUrl)) !== false) {
      enqueued += 1;
    }
  }
  return enqueued;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────────

export interface PodcastSearchSyncDeps {
  search?: (query: string, limit?: number) => Promise<PodcastDirectoryCandidate[]>;
  enqueue?: (feedUrl: string, directory?: PodcastDirectoryCandidate) => boolean | void;
  now?: () => number;
}

export interface PodcastSearchSyncResult {
  skipped: boolean;
  candidates: number;
  shallowUpserted: number;
  deepEnqueued: number;
}

/**
 * Fast, bounded, idempotent search enrichment. Hits the directory (capped +
 * timed out), shallow-upserts every candidate so they show immediately, and
 * enqueues background deep imports for new/stale shows. Throttled per query.
 * NEVER throws — safe to `await` in the request path or fire-and-forget.
 */
export async function syncPodcastSearch(
  query: string,
  deps: PodcastSearchSyncDeps = {},
): Promise<PodcastSearchSyncResult> {
  const empty: PodcastSearchSyncResult = { skipped: true, candidates: 0, shallowUpserted: 0, deepEnqueued: 0 };
  if (!bulkImportEnabled()) return empty;

  const search = deps.search ?? directorySearch;
  const enqueue = deps.enqueue ?? enqueuePodcastImport;
  const now = (deps.now ?? Date.now)();

  const key = normalizeQuery(query);
  if (!key) return empty;

  const last = lastSyncAt.get(key);
  if (last !== undefined && now - last < SEARCH_IMPORT_TTL_MS) return empty;
  lastSyncAt.set(key, now);

  let candidates: PodcastDirectoryCandidate[];
  try {
    candidates = (await withTimeout(search(key, MAX_FEEDS_PER_SEARCH), DIRECTORY_TIMEOUT_MS, [])).slice(
      0,
      MAX_FEEDS_PER_SEARCH,
    );
  } catch (err) {
    logger.warn('[podcast-import] directory search failed', { query: key, err });
    return { ...empty, skipped: false };
  }

  if (candidates.length === 0) return { ...empty, skipped: false };

  await shallowUpsertCandidates(candidates);
  let deepEnqueued = 0;
  try {
    deepEnqueued = await enqueueDeepImports(candidates, enqueue, now);
  } catch (err) {
    logger.warn('[podcast-import] deep-import scheduling failed', { query: key, err });
  }

  logger.info('[podcast-import] search sync', { query: key, candidates: candidates.length, deepEnqueued });
  return { skipped: false, candidates: candidates.length, shallowUpserted: candidates.length, deepEnqueued };
}

/** Test-only: reset module throttle/dedup state between cases. */
export function resetPodcastImportStateForTests(): void {
  lastSyncAt.clear();
  queuedFeeds.clear();
  importQueue = Promise.resolve();
}
