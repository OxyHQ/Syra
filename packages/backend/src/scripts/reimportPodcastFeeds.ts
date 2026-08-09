/**
 * Rebuild the podcast catalogue from `data/podcast-feeds.txt`.
 *
 * The Postgres cutover was a clean start, so the catalogue came up empty. Shows
 * and episodes are a MIRROR of external RSS rather than original data —
 * `importFeed` is documented idempotent, "re-running upserts the same
 * show/episodes" — so the feed URLs are the only input needed to reconstruct
 * them, and they were exported before the cutover.
 *
 * Idempotent by construction: re-running skips nothing and breaks nothing, so a
 * partial run needs no bookkeeping to resume. Just run it again.
 *
 * Usage:
 *   bun run src/scripts/reimportPodcastFeeds.ts [--concurrency=4] [--limit=N]
 *
 * `--limit` imports only the first N feeds, for a smoke run before the full one.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { connectPostgres, closePostgres } from '../db/postgres';
import { importFeed } from '../services/podcasts/podcastImportService';
import { describeErrorSafely } from '../utils/error';
import { logger } from '../utils/logger';

/**
 * Four at a time, deliberately.
 *
 * Every unit is an outbound fetch to someone else's server, and a few of these
 * feeds carry thousands of episodes. Concurrency here buys wall-clock at the cost
 * of hammering hosts that never agreed to it, so the default stays low enough to
 * be a good citizen and is overridable for a machine with a reason.
 */
const DEFAULT_CONCURRENCY = 4;

function numericFlag(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const value = Number.parseInt(raw.slice(name.length + 3), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Find `data/` by walking UP from this module, not by counting `..`.
 *
 * The compiled layout is not the source layout: `tsc` emits this file to
 * `dist/src/scripts/`, while it lives at `src/scripts/`. A fixed
 * `join(__dirname, '..', '..', 'data')` therefore resolves correctly when run
 * from source and lands on `dist/data` — which does not exist — inside the image.
 * The failure surfaces only in production, after a deploy has already reported
 * success, which is exactly the kind a local run cannot catch.
 */
function resolveDataDir(): string {
  let dir = __dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, 'data');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`Could not locate a data/ directory above ${__dirname}`);
}

async function main(): Promise<void> {
  const concurrency = numericFlag('concurrency', DEFAULT_CONCURRENCY);
  const limit = numericFlag('limit', 0);

  const file = path.join(resolveDataDir(), 'podcast-feeds.txt');
  const feeds = (await readFile(file, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('http'));

  const targets = limit > 0 ? feeds.slice(0, limit) : feeds;
  logger.info(`Re-importing ${targets.length} feed(s) at concurrency ${concurrency}`);

  let done = 0;
  let ok = 0;
  const failures: Array<{ feedUrl: string; reason: string }> = [];

  // A hand-rolled pool rather than chunked `Promise.all`: chunking waits for the
  // slowest feed in every batch, and one 4,000-episode show would stall three
  // workers behind it for minutes.
  const queue = [...targets];
  async function worker(): Promise<void> {
    for (;;) {
      const feedUrl = queue.shift();
      if (feedUrl === undefined) return;
      try {
        const result = await importFeed(feedUrl);
        ok += 1;
        logger.debug('imported', { feedUrl, podcastId: result.podcast.id });
      } catch (error: unknown) {
        // A dead or moved feed is expected at this scale and must not stop the
        // run — the reason is recorded so the tail can be triaged afterwards.
        failures.push({ feedUrl, reason: describeErrorSafely(error) });
      }
      done += 1;
      if (done % 25 === 0 || done === targets.length) {
        logger.info(`progress ${done}/${targets.length} — ok ${ok}, failed ${failures.length}`);
      }
    }
  }

  await connectPostgres();
  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    await closePostgres();
  }

  logger.info(`Done: ${ok} imported, ${failures.length} failed, of ${targets.length}`);
  for (const failure of failures.slice(0, 40)) {
    logger.warn('feed failed', failure);
  }
  if (failures.length > 40) {
    logger.warn(`… and ${failures.length - 40} more`);
  }
}

void main().catch((error: unknown) => {
  logger.error('Re-import failed', { err: describeErrorSafely(error) });
  process.exitCode = 1;
});
