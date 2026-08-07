import { getDb } from '../../db/postgres';
import {
  disableContributorUploads,
  ensureContributorStanding,
  findContributorStanding,
  incrementStrikeCount,
  insertContributorStrike,
  listContributorStrikes,
  terminateContributor,
  type ContributorStandingRow,
  type ContributorStrikeRow,
} from '../../db/creators/standings';
import { STRIKE_TERMINATION_THRESHOLD, isRepeatInfringer } from '../strikeService';
import { logger } from '../../utils/logger';

/**
 * The repeat-infringer counter for ordinary Oxy accounts.
 *
 * The same policy `strikeService` applies to artists, applied to the population
 * that has no artist profile: a listener who publishes to the public catalogue
 * through the contribution path. Same threshold — imported from `strikeService`
 * rather than redeclared, so the two populations cannot drift to different
 * numbers — and the same terminal state.
 *
 * This module is a LEAF on purpose. It counts and it decides; it does not remove
 * anything. Applying the consequences of a termination (taking the account's
 * contributed recordings down, purging its locker) belongs to `takedown.ts`,
 * which already owns every path that deletes content — and if this module called
 * back into it, a takedown would strike, and a strike would take down, and the
 * two would be mutually recursive.
 */

export interface ContributorStrikeOutcome {
  oxyUserId: string;
  strikeCount: number;
  /** True only on the transition INTO termination, so the caller cascades once. */
  terminated: boolean;
  /** True when this account was already terminated before the call. */
  alreadyTerminated: boolean;
}

/** A standing with its strikes attached — the shape `getContributorStanding` returns. */
export interface ContributorStanding extends ContributorStandingRow {
  strikes: ContributorStrikeRow[];
}

/**
 * Record one infringement against an Oxy account.
 *
 * Upserts, because the first strike is also the first time the account is heard
 * of — a contributor has no record until they need one, and pre-creating a
 * standing row for every uploader would be a table of empty rows.
 *
 * ## One transaction, and the counter is incremented by the database
 *
 * `Contributor.strikes[]` became a child table, so what was one `document
 * .save()` is now an insert plus an update plus, sometimes, a termination — and
 * a failure between them would leave a strike nobody counted or a count with no
 * strike behind it. They run together.
 *
 * The count itself is `strike_count + 1` in SQL rather than a read, an
 * increment in JavaScript and a write back. The Mongo version did the latter,
 * so two takedowns resolved concurrently could both read 2 and both write 3 —
 * leaving a repeat infringer one strike short of the threshold with nothing to
 * show that it had happened.
 */
export async function recordContributorStrike(
  oxyUserId: string,
  reason: string,
  trackId?: string,
): Promise<ContributorStrikeOutcome> {
  const now = new Date();

  const outcome = await getDb().transaction(async (tx) => {
    const standing = await ensureContributorStanding(tx, oxyUserId);
    const alreadyTerminated = standing.terminated;

    await insertContributorStrike(tx, {
      contributorStandingId: standing.id,
      reason,
      trackId,
      createdAt: now,
    });
    const strikeCount = await incrementStrikeCount(tx, standing.id, now);

    if (!isRepeatInfringer(strikeCount)) {
      return { oxyUserId, strikeCount, terminated: false, alreadyTerminated };
    }

    if (alreadyTerminated) {
      // Still disable uploads: the account is over the threshold, and the
      // termination write below is the one thing that must not repeat.
      await disableContributorUploads(tx, standing.id);
      return { oxyUserId, strikeCount, terminated: false, alreadyTerminated };
    }

    /**
     * `terminated` is reported from the WRITE, not from the count.
     *
     * It is the caller's signal to cascade — take the account's contributed
     * recordings down and purge its locker — and cascading twice for one event
     * would delete a locker twice and notify the owner twice. The update carries
     * `terminated = false` in its WHERE, so exactly one concurrent call can win
     * it however many arrive together.
     */
    const terminated = await terminateContributor(
      tx,
      standing.id,
      `Repeat-infringer termination: ${STRIKE_TERMINATION_THRESHOLD} or more copyright strikes`,
      now,
    );

    return { oxyUserId, strikeCount, terminated, alreadyTerminated };
  });

  logger.info(
    `[ContributorStrikes] Strike ${outcome.strikeCount} recorded against ${oxyUserId}` +
    (outcome.terminated ? ' — account TERMINATED as a repeat infringer' : ''),
  );

  return outcome;
}

/**
 * May this account publish to the PUBLIC catalogue?
 *
 * Only the public path is gated. The private locker is storage at the user's own
 * instruction rather than distribution, so it answers a different question and is
 * decided elsewhere — an account blocked from contributing can still keep its own
 * music, right up until termination.
 */
export async function canContributePublicly(oxyUserId: string): Promise<boolean> {
  const standing = await findContributorStanding(oxyUserId);

  // No record at all is the ordinary case: nobody has ever had cause to open one.
  if (!standing) return true;
  return !standing.terminated && !standing.uploadsDisabled;
}

/** The account's current standing, or null when it has never been struck. */
export async function getContributorStanding(
  oxyUserId: string,
): Promise<ContributorStanding | null> {
  const standing = await findContributorStanding(oxyUserId);
  if (!standing) return null;

  // The strikes were an embedded array and are a child table now, so the
  // caller's `standing.strikes` needs a second read rather than arriving with
  // the row. Both callers of this function render the list, so it is not
  // optional here.
  return { ...standing, strikes: await listContributorStrikes(standing.id) };
}
