import { sweepAllExpiredRows } from '@oxyhq/db/expiry';
import { withLock } from '../../utils/distributedLock';
import { getDb, isPostgresConnected } from '../../db/postgres';
import { EXPIRY_SWEEP_TARGETS } from '../../db/expiry';
import { decayAllTasteProfiles } from './tasteDecay';
import { runCoOccurrencePass } from './coOccurrenceJob';
import { describeErrorSafely } from '../../utils/error';
import { logger } from '../../utils/logger';

/**
 * In-process scheduler for recommendation maintenance. There is no external job
 * runner in this stack; we use a simple interval guarded by a Redis distributed
 * lock so that across a horizontally-scaled fleet the heavy work runs on exactly
 * one instance per tick. If Redis is unavailable the lock can't be taken and the
 * tick is skipped — safe, since these are non-critical periodic aggregates.
 *
 * ## The expiry sweep runs here, and Task 15 is why it had to start
 *
 * `db/expiry.ts` is the Postgres replacement for a Mongo TTL index, and it names
 * this file as the natural home for the sweep. It stayed unwired while those two
 * tables were empty and Mongo's TTL monitor was still doing the work — and Task
 * 15 is the change that ends that: `listening_events` and
 * `notification_suppressions` are now the live store, so an unwired registry
 * means both grow FOREVER, with no error and no failing test until disk.
 *
 * `listening_events` sets the batch ceiling. It is the only high-arrival-rate
 * table in the registry (one row per play), and `sweepExpiredRows`' per-call
 * ceiling is `batchSize × maxBatches`. At the defaults (1,000 × 50 = 50,000) and
 * this 30-minute tick that is 48 × 50,000 = 2.4M rows/day of headroom. That is
 * the number to re-check if play volume ever approaches it — not the defaults to
 * copy — which is why `truncated` is logged per table rather than discarded: a
 * backlog growing without bound otherwise reports success on every single run.
 */

/** How often the maintenance tick fires on each instance. */
const TICK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/** First tick is delayed so it never competes with cold-start boot work. */
const INITIAL_DELAY_MS = 2 * 60 * 1000; // 2 minutes

/** Lock TTL must comfortably exceed a worst-case pass duration. */
const CO_OCCURRENCE_LOCK_TTL_MS = 20 * 60 * 1000;
const DECAY_LOCK_TTL_MS = 5 * 60 * 1000;
const EXPIRY_SWEEP_LOCK_TTL_MS = 10 * 60 * 1000;

let started = false;
let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return; // never overlap on the same instance
  running = true;
  try {
    // Co-occurrence graph rebuild (single instance via lock).
    await withLock('recommendations:co-occurrence', CO_OCCURRENCE_LOCK_TTL_MS, async () => {
      try {
        await runCoOccurrencePass();
      } catch (err) {
        logger.warn('[recommendations] co-occurrence pass failed', {
          error: describeErrorSafely(err),
        });
      }
    });

    // Recency decay of taste profiles (single instance via lock).
    await withLock('recommendations:taste-decay', DECAY_LOCK_TTL_MS, async () => {
      try {
        await decayAllTasteProfiles();
      } catch (err) {
        logger.warn('[recommendations] taste decay failed', {
          error: describeErrorSafely(err),
        });
      }
    });

    // Expiry sweep — the replacement for the Mongo TTL indexes.
    await withLock('db:expiry-sweep', EXPIRY_SWEEP_LOCK_TTL_MS, sweepExpiredTables);
  } finally {
    running = false;
  }
}

/**
 * Delete every row past its retention, one registered target at a time.
 *
 * `truncated` is logged rather than dropped: it is the ONLY signal that a
 * table's arrival rate has outrun the per-call ceiling, and without it a
 * backlog growing without bound looks exactly like a healthy sweep.
 */
async function sweepExpiredTables(): Promise<void> {
  if (!isPostgresConnected()) return;

  try {
    const results = await sweepAllExpiredRows(getDb(), EXPIRY_SWEEP_TARGETS);

    for (const result of results) {
      if (result.truncated) {
        logger.warn('[expiry] sweep hit its batch ceiling — rows remain for the next tick', {
          table: result.table,
          deleted: result.deleted,
        });
      } else if (result.deleted > 0) {
        logger.info('[expiry] swept expired rows', {
          table: result.table,
          deleted: result.deleted,
        });
      }
    }
  } catch (err) {
    logger.warn('[expiry] sweep failed', { error: describeErrorSafely(err) });
  }
}

/**
 * Start the recommendation maintenance scheduler. Idempotent: calling twice is a
 * no-op. The first tick is delayed; subsequent ticks fire on a fixed interval.
 */
export function startRecommendationScheduler(): void {
  if (started) return;
  started = true;

  setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }, INITIAL_DELAY_MS).unref?.();

  logger.info('[recommendations] maintenance scheduler started', {
    intervalMinutes: TICK_INTERVAL_MS / 60000,
  });
}

/** Stop the scheduler (used in tests / graceful shutdown). */
export function stopRecommendationScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}
