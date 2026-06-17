import { withLock } from '../../utils/distributedLock';
import { decayAllTasteProfiles } from './tasteDecay';
import { runCoOccurrencePass } from './coOccurrenceJob';
import { logger } from '../../utils/logger';

/**
 * In-process scheduler for recommendation maintenance. There is no external job
 * runner in this stack; we use a simple interval guarded by a Redis distributed
 * lock so that across a horizontally-scaled fleet the heavy work runs on exactly
 * one instance per tick. If Redis is unavailable the lock can't be taken and the
 * tick is skipped — safe, since these are non-critical periodic aggregates.
 */

/** How often the maintenance tick fires on each instance. */
const TICK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/** First tick is delayed so it never competes with cold-start boot work. */
const INITIAL_DELAY_MS = 2 * 60 * 1000; // 2 minutes

/** Lock TTL must comfortably exceed a worst-case pass duration. */
const CO_OCCURRENCE_LOCK_TTL_MS = 20 * 60 * 1000;
const DECAY_LOCK_TTL_MS = 5 * 60 * 1000;

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
        logger.warn('[recommendations] co-occurrence pass failed', { err });
      }
    });

    // Recency decay of taste profiles (single instance via lock).
    await withLock('recommendations:taste-decay', DECAY_LOCK_TTL_MS, async () => {
      try {
        await decayAllTasteProfiles();
      } catch (err) {
        logger.warn('[recommendations] taste decay failed', { err });
      }
    });
  } finally {
    running = false;
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
