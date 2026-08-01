import { ContributorStandingModel, type IContributorStanding } from '../../models/ContributorStanding';
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

/**
 * Record one infringement against an Oxy account.
 *
 * Upserts, because the first strike is also the first time the account is heard
 * of — a contributor has no record until they need one, and pre-creating a
 * standing row for every uploader would be a collection of empty documents.
 */
export async function recordContributorStrike(
  oxyUserId: string,
  reason: string,
  trackId?: string,
): Promise<ContributorStrikeOutcome> {
  const standing = await ContributorStandingModel.findOneAndUpdate(
    { oxyUserId },
    { $setOnInsert: { oxyUserId } },
    { upsert: true, returnDocument: 'after' },
  );

  const alreadyTerminated = standing.terminated === true;

  standing.strikes = standing.strikes ?? [];
  standing.strikes.push({ reason, createdAt: new Date(), trackId });
  standing.strikeCount = (standing.strikeCount ?? 0) + 1;
  standing.lastStrikeAt = new Date();

  let terminated = false;
  if (isRepeatInfringer(standing.strikeCount)) {
    standing.uploadsDisabled = true;
    if (!alreadyTerminated) {
      standing.terminated = true;
      standing.terminatedAt = new Date();
      standing.terminationReason =
        `Repeat-infringer termination: ${STRIKE_TERMINATION_THRESHOLD} or more copyright strikes`;
      terminated = true;
    }
  }

  await standing.save();

  logger.info(
    `[ContributorStrikes] Strike ${standing.strikeCount} recorded against ${oxyUserId}` +
    (terminated ? ' — account TERMINATED as a repeat infringer' : ''),
  );

  return {
    oxyUserId,
    strikeCount: standing.strikeCount,
    terminated,
    alreadyTerminated,
  };
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
  const standing = await ContributorStandingModel.findOne({ oxyUserId })
    .select('terminated uploadsDisabled')
    .lean();

  // No record at all is the ordinary case: nobody has ever had cause to open one.
  if (!standing) return true;
  return standing.terminated !== true && standing.uploadsDisabled !== true;
}

/** The account's current standing, or null when it has never been struck. */
export async function getContributorStanding(
  oxyUserId: string,
): Promise<IContributorStanding | null> {
  return ContributorStandingModel.findOne({ oxyUserId });
}
