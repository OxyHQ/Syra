import { decayDueTasteProfiles, type TasteDecayResult } from '../../db/user/taste';
import { isPostgresConnected } from '../../db/postgres';
import { describeErrorSafely } from '../../utils/error';
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
 *
 * ## What moved, and what is left here
 *
 * The half-life, the prune threshold and the pass itself are in
 * `db/user/taste.ts`, beside the tables they act on — five set-wise statements
 * rather than a cursor issuing one `save()` per profile. What remains here is
 * the scheduler's contract: a pass never throws, and an unavailable database is
 * a no-op rather than an error, because the caller is a timer with nobody to
 * report to.
 *
 * The connectivity gate now asks POSTGRES. It asked `isDatabaseConnected()`
 * (`utils/database.ts`, `mongoose.connection.readyState`) before this port,
 * which after it would have been a gate on the wrong database entirely —
 * permitting the pass while Postgres was still opening, and silencing it
 * forever once Mongo is removed.
 */

export type { TasteDecayResult } from '../../db/user/taste';

/**
 * Apply recency decay to all taste profiles that are due. Idempotent and
 * time-proportional: a profile decayed twice in quick succession barely changes
 * the second time.
 *
 * Best-effort as a WHOLE, where the Mongo version was best-effort per profile.
 * That difference is the transaction's doing: five set-wise statements either
 * all commit or none do, so there is no half-decayed state for a per-profile
 * `catch` to salvage. A failed pass costs nothing — the next tick recomputes the
 * same factors from the same untouched `last_decay_at`, which is the property
 * that made this pass idempotent in the first place.
 */
export async function decayAllTasteProfiles(): Promise<TasteDecayResult> {
  if (!isPostgresConnected()) return { profilesProcessed: 0 };

  try {
    const result = await decayDueTasteProfiles();
    if (result.profilesProcessed > 0) {
      logger.info('[recommendations] taste decay pass complete', {
        profilesProcessed: result.profilesProcessed,
      });
    }
    return result;
  } catch (err) {
    logger.warn('[recommendations] taste decay pass failed', { error: describeErrorSafely(err) });
    return { profilesProcessed: 0 };
  }
}
