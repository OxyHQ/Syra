import { UserTasteProfileModel } from '../../models/UserTasteProfile';
import { isDatabaseConnected } from '../../utils/database';
import { logger } from '../../utils/logger';

/**
 * Recency decay for taste profiles. Tastes evolve, so without decay a user's
 * profile would forever be dominated by whatever they listened to most in their
 * first month. Each maintenance pass multiplies every weight by a half-life
 * decay factor proportional to the elapsed time since the last decay, then
 * prunes weights that have decayed to insignificance.
 *
 * Applying decay time-proportionally (rather than a fixed factor per tick) makes
 * the result independent of how often the scheduler happens to run.
 */

/** Weights lose half their value over this period of no reinforcement. */
const HALF_LIFE_DAYS = 45;

/** Drop weights below this after decay to keep profiles compact. */
const PRUNE_THRESHOLD = 0.05;

/** Process profiles in batches to bound memory. */
const BATCH_SIZE = 500;

export interface TasteDecayResult {
  profilesProcessed: number;
}

/**
 * Apply recency decay to all taste profiles that are due. Idempotent and
 * time-proportional: a profile decayed twice in quick succession barely changes
 * the second time. Best-effort per profile; one failure never aborts the pass.
 */
export async function decayAllTasteProfiles(): Promise<TasteDecayResult> {
  if (!isDatabaseConnected()) return { profilesProcessed: 0 };

  const now = Date.now();
  const halfLifeMs = HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;

  let processed = 0;
  const cursor = UserTasteProfileModel.find({}).batchSize(BATCH_SIZE).cursor();

  for await (const profile of cursor) {
    try {
      const lastDecay = profile.lastDecayAt instanceof Date ? profile.lastDecayAt.getTime() : now;
      const elapsed = Math.max(0, now - lastDecay);
      if (elapsed === 0) continue;

      const factor = Math.pow(0.5, elapsed / halfLifeMs);
      if (factor >= 0.999) continue; // not enough time passed to matter

      let total = 0;
      profile.genres = profile.genres
        .map((g) => ({ key: g.key, weight: g.weight * factor }))
        .filter((g) => g.weight >= PRUNE_THRESHOLD);
      profile.artists = profile.artists
        .map((a) => ({ key: a.key, weight: a.weight * factor }))
        .filter((a) => a.weight >= PRUNE_THRESHOLD);
      for (const a of profile.artists) total += a.weight;

      profile.totalSignal = total;
      profile.lastDecayAt = new Date(now);
      await profile.save();
      processed++;
    } catch (err) {
      logger.debug('[recommendations] taste decay skipped a profile', { err });
    }
  }

  if (processed > 0) {
    logger.info('[recommendations] taste decay pass complete', { profilesProcessed: processed });
  }
  return { profilesProcessed: processed };
}
