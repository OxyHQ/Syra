/**
 * Background bulk import-on-search — mirrors `enqueueAudiusImport`.
 *
 * When a user searches podcasts we enrich the catalog with the WHOLE directory
 * result set, not just the show they tap: `searchPodcasts` (Podcast Index +
 * Apple) → enqueue `importFeed` for EVERY new candidate. This replaces
 * import-on-tap entirely.
 *
 * Safety rails:
 *  - Fire-and-forget; never throws into the request path.
 *  - Imports run ONE AT A TIME on a serialized queue (natural rate limit so a
 *    search can't hammer the import path or the directories).
 *  - Per-query TTL throttle (repeat searches within the window are skipped).
 *  - Capped at {@link MAX_FEEDS_PER_SEARCH} candidates per search.
 *  - Deduped against the existing catalog by `feedUrl`/`podcastGuid`, and by
 *    in-flight `feedUrl` so the same feed isn't queued twice.
 *  - Env kill-switch `PODCAST_BULK_IMPORT_ENABLED=false`.
 */

import { PodcastModel } from '../../models/Podcast';
import { logger } from '../../utils/logger';
import { searchPodcasts as directorySearch, type PodcastDirectoryCandidate } from './PodcastDirectory';
import { importFeed } from './podcastImportService';

/** Minimum gap between bulk imports for the same normalized query (10 min). */
const SEARCH_IMPORT_TTL_MS = 10 * 60 * 1000;

/** Max directory candidates imported per search (cost + rate cap). */
export const MAX_FEEDS_PER_SEARCH = 25;

const lastSearchImportAt = new Map<string, number>();
const queuedFeeds = new Set<string>();
let importQueue: Promise<void> = Promise.resolve();

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function bulkImportEnabled(): boolean {
  return process.env.PODCAST_BULK_IMPORT_ENABLED !== 'false';
}

/** Already mirrored? Dedup by feedUrl/podcastGuid so we never re-import a show. */
async function alreadyInCatalog(candidate: PodcastDirectoryCandidate): Promise<boolean> {
  const or: Record<string, unknown>[] = [{ feedUrl: candidate.feedUrl }];
  if (candidate.podcastGuid) or.push({ podcastGuid: candidate.podcastGuid });
  const exists = await PodcastModel.exists({ $or: or });
  return exists !== null;
}

/**
 * Enqueue a SINGLE feed import onto the serialized background queue. Deduped by
 * feedUrl while in-flight. Fire-and-forget; never throws.
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
        logger.warn('[podcast-import] feed import failed', { feedUrl, err });
      } finally {
        queuedFeeds.delete(key);
      }
    });
}

export interface PodcastSearchImportDeps {
  /** Directory search; defaults to the real Podcast Index + Apple search. */
  search?: (query: string, limit?: number) => Promise<PodcastDirectoryCandidate[]>;
  /** Per-feed enqueue; defaults to {@link enqueuePodcastImport}. Injectable for tests. */
  enqueue?: (feedUrl: string, directory?: PodcastDirectoryCandidate) => void;
  /** Clock; defaults to `Date.now`. Inject for testable throttling. */
  now?: () => number;
}

export interface PodcastSearchImportResult {
  skipped: boolean;
  candidates: number;
  enqueued: number;
}

/**
 * Search the directories and enqueue importFeed for every NEW candidate (capped
 * + deduped). Throttled per normalized query. Returns counts for observability.
 */
export async function runPodcastSearchImport(
  query: string,
  deps: PodcastSearchImportDeps = {},
): Promise<PodcastSearchImportResult> {
  const search = deps.search ?? directorySearch;
  const enqueue = deps.enqueue ?? enqueuePodcastImport;
  const now = deps.now ?? Date.now;

  const key = normalizeQuery(query);
  if (!key) return { skipped: true, candidates: 0, enqueued: 0 };

  const last = lastSearchImportAt.get(key);
  if (last !== undefined && now() - last < SEARCH_IMPORT_TTL_MS) {
    return { skipped: true, candidates: 0, enqueued: 0 };
  }
  lastSearchImportAt.set(key, now());

  const candidates = (await search(key, MAX_FEEDS_PER_SEARCH)).slice(0, MAX_FEEDS_PER_SEARCH);
  let enqueued = 0;
  for (const candidate of candidates) {
    try {
      if (await alreadyInCatalog(candidate)) continue;
      enqueue(candidate.feedUrl, candidate);
      enqueued += 1;
    } catch (err) {
      logger.debug('[podcast-import] candidate dedup check failed', { feedUrl: candidate.feedUrl, err });
    }
  }

  logger.info('[podcast-import] search import pass', { query: key, candidates: candidates.length, enqueued });
  return { skipped: false, candidates: candidates.length, enqueued };
}

/**
 * Fire-and-forget wrapper for the request path. No-op when disabled or blank.
 * Never throws.
 */
export function enqueuePodcastSearchImport(query: string, deps?: PodcastSearchImportDeps): void {
  if (!bulkImportEnabled()) return;
  const key = normalizeQuery(query);
  if (!key) return;
  void runPodcastSearchImport(key, deps).catch((err) =>
    logger.error('[podcast-import] search import failed', { query: key, err }),
  );
}

/** Test-only: reset the module throttle/dedup state between cases. */
export function resetPodcastImportStateForTests(): void {
  lastSearchImportAt.clear();
  queuedFeeds.clear();
  importQueue = Promise.resolve();
}
