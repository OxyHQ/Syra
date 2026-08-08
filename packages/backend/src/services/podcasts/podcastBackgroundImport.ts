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

import {
  findDeepImportTargets,
  shallowUpsertPodcasts,
  type ShallowCandidate,
} from '../../db/podcasts/podcasts';
import { logger } from '../../utils/logger';
import { searchPodcasts as directorySearch, type PodcastDirectoryCandidate } from './PodcastDirectory';
import { importFeed } from './podcastImportService';
import { describeErrorSafely } from '../../utils/error';

/** Minimum gap between directory syncs for the same normalized query (10 min). */
const SEARCH_IMPORT_TTL_MS = 10 * 60 * 1000;

/** Max directory candidates handled per search (cost + rate cap). */
export const MAX_FEEDS_PER_SEARCH = 25;

/** Hard timeout on the in-request directory call so a search can never hang. */
const DIRECTORY_TIMEOUT_MS = 3000;

/** Re-pull a show's full feed at most this often from search (24h). */
const DEEP_REFRESH_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Cap on retained throttle keys.
 *
 * `lastSyncAt` is keyed on the normalized SEARCH QUERY, which reaches us from
 * `GET /api/search` with no authentication — so its key space is chosen by the
 * caller, not by our catalog. Every distinct query long enough to trigger an
 * import used to add an entry that nothing ever removed, which makes anonymous
 * search a slow, permanent memory leak: cheap to drive, invisible until the
 * process is restarted, and indistinguishable from ordinary traffic.
 *
 * Insertion order is what makes eviction correct here. A JS `Map` iterates in
 * insertion order, and a repeat query inside its TTL returns early WITHOUT
 * re-setting the key, so the oldest key is always the least recently admitted —
 * exactly the one whose TTL is closest to expiring anyway. Evicting it can
 * therefore only ever allow an import that the TTL was about to allow regardless.
 */
export const MAX_THROTTLE_KEYS = 500;

const lastSyncAt = new Map<string, number>();
const queuedFeeds = new Set<string>();
let importQueue: Promise<void> = Promise.resolve();

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Record a sync and hold the throttle map at {@link MAX_THROTTLE_KEYS} entries,
 * dropping the oldest-admitted keys first. A loop rather than a single delete so
 * the bound holds even if the cap is ever lowered below the current size.
 */
function rememberSync(key: string, now: number): void {
  lastSyncAt.set(key, now);
  while (lastSyncAt.size > MAX_THROTTLE_KEYS) {
    const oldest = lastSyncAt.keys().next().value;
    if (oldest === undefined) break;
    lastSyncAt.delete(oldest);
  }
}

function bulkImportEnabled(): boolean {
  return process.env.PODCAST_BULK_IMPORT_ENABLED !== 'false';
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

  const rows: ShallowCandidate[] = candidates.map((candidate) => {
    // Refresh directory-owned metadata on every sync. The Syra image id is
    // owned by the deep re-host step and is never touched here; the external
    // artwork URL lives in `imageSourceUrl` for instant display.
    const set = {
      title: candidate.title,
      author: candidate.author,
      imageSourceUrl: candidate.image,
    };

    return {
      feedUrl: candidate.feedUrl,
      set,
      insert: {
        ...set,
        feedUrl: candidate.feedUrl,
        // Stable identity + flags set once, on insert.
        source: 'rss' as const,
        status: 'active' as const,
        claimable: true,
        needsDeepImport: true,
        podcastGuid: candidate.podcastGuid,
        podcastIndexId: candidate.podcastIndexId,
        appleCollectionId: candidate.appleCollectionId,
      },
      /**
       * Categories are a JUNCTION now, so `undefined` (leave alone) and `[]`
       * (erase) are different writes and the Mongo conditional spread has to be
       * preserved exactly. It read `...(categories.length > 0 ? { categories } :
       * {})` — a directory result with no categories must not wipe the ones the
       * deep feed import already resolved.
       */
      ...(candidate.categories.length > 0 ? { categories: candidate.categories } : {}),
    };
  });

  /**
   * Mongo's `bulkWrite(..., { ordered: false })` let one bad candidate fail on
   * its own; `shallowUpsertPodcasts` keeps that by isolating per row, and takes
   * the error handler so the log line stays here with the rest of this module's
   * logging rather than inside the data layer.
   */
  await shallowUpsertPodcasts(rows, (feedUrl, err) =>
    logger.warn('[podcast-import] shallow upsert failed for one candidate', { feedUrl, err: describeErrorSafely(err) })
  );
}

// ── Deep import (background) ─────────────────────────────────────────────────────

/**
 * Enqueue a SINGLE feed's deep import onto the serialized background queue.
 * Deduped by in-flight feedUrl. Fire-and-forget; never throws.
 */
export function enqueuePodcastImport(feedUrl: string, directory?: PodcastDirectoryCandidate): void {
  const key = feedUrl.trim().toLowerCase();
  if (!key) return;
  if (queuedFeeds.has(key)) return;
  queuedFeeds.add(key);

  importQueue = importQueue
    .catch(() => {
      // Keep the queue alive after a previous fire-and-forget failure.
    })
    .then(async () => {
      try {
        await importFeed(feedUrl, directory ? { directory } : {});
      } catch (err) {
        logger.warn('[podcast-import] deep feed import failed', { feedUrl, err: describeErrorSafely(err) });
      } finally {
        queuedFeeds.delete(key);
      }
    });
}

/**
 * Among the just-upserted candidate feeds, enqueue a deep import only for those
 * that are new (`needsDeepImport`) or stale (feed not re-fetched recently).
 * Already-fresh shows are NOT re-pulled, so search never re-fetches a 15MB feed
 * on every keystroke.
 */
async function enqueueDeepImports(
  candidates: PodcastDirectoryCandidate[],
  enqueue: (feedUrl: string, directory?: PodcastDirectoryCandidate) => void,
  now: number,
): Promise<number> {
  const feedUrls = candidates.map((c) => c.feedUrl);
  const staleBefore = new Date(now - DEEP_REFRESH_STALE_MS);
  const targets = await findDeepImportTargets(feedUrls, staleBefore);

  const byFeedUrl = new Map(candidates.map((c) => [c.feedUrl, c]));
  let enqueued = 0;
  for (const feedUrl of targets) {
    enqueue(feedUrl, byFeedUrl.get(feedUrl));
    enqueued += 1;
  }
  return enqueued;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────────

export interface PodcastSearchSyncDeps {
  search?: (query: string, limit?: number) => Promise<PodcastDirectoryCandidate[]>;
  enqueue?: (feedUrl: string, directory?: PodcastDirectoryCandidate) => void;
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
  rememberSync(key, now);

  let candidates: PodcastDirectoryCandidate[];
  try {
    candidates = (await withTimeout(search(key, MAX_FEEDS_PER_SEARCH), DIRECTORY_TIMEOUT_MS, [])).slice(
      0,
      MAX_FEEDS_PER_SEARCH,
    );
  } catch (err) {
    logger.warn('[podcast-import] directory search failed', { query: key, err: describeErrorSafely(err) });
    return { ...empty, skipped: false };
  }

  if (candidates.length === 0) return { ...empty, skipped: false };

  await shallowUpsertCandidates(candidates);
  let deepEnqueued = 0;
  try {
    deepEnqueued = await enqueueDeepImports(candidates, enqueue, now);
  } catch (err) {
    logger.warn('[podcast-import] deep-import scheduling failed', { query: key, err: describeErrorSafely(err) });
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
