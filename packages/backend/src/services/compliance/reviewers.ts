import { logger } from '../../utils/logger';

/**
 * Who may resolve a compliance decision.
 *
 * Two decisions in this codebase are irreversible and carry statutory weight: a
 * copyright report that becomes a takedown (`copyrightRemoved`, a strike, and a
 * purge of every locker holding the same recording), and an artist claim that
 * hands a stranger the profile a real artist's recordings hang from. Neither can
 * be a self-service action, and Syra has no role system to lean on — the only
 * roles that exist anywhere in this backend belong to a House.
 *
 * So the reviewer set is deployment configuration: an explicit list of Oxy user
 * ids, in an environment variable, alongside the CrowdSource credentials it sits
 * next to conceptually. It is READ PER CALL rather than frozen at import, for the
 * same reason `crowdSourceConfig` is re-derivable — a reviewer added to the task
 * definition takes effect on the next request, not on the next deploy of a
 * process that happened to import this module first.
 *
 * FAIL CLOSED. An unset, empty or malformed variable yields an empty set and
 * therefore nobody: a misconfiguration must not be the reason a track leaves the
 * catalog or an impersonated profile changes hands. The absence is logged,
 * because "the review queue answers 403 to everyone" is otherwise indistinguishable
 * from "this user is not a reviewer".
 */
export const COMPLIANCE_REVIEWERS_ENV = 'SYRA_COMPLIANCE_REVIEWERS';

/** The configured reviewer ids, or an empty set when none are configured. */
export function complianceReviewerIds(): ReadonlySet<string> {
  const raw = process.env[COMPLIANCE_REVIEWERS_ENV];
  if (!raw) return new Set<string>();
  return new Set(
    raw
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/** True when this Oxy user is allowed to resolve compliance decisions. */
export function isComplianceReviewer(oxyUserId: string): boolean {
  const reviewers = complianceReviewerIds();
  if (reviewers.size === 0) {
    logger.warn(
      `[Compliance] ${COMPLIANCE_REVIEWERS_ENV} is not configured — every review ` +
      'endpoint refuses. Copyright reports and artist claims stay pending until it is set.',
    );
    return false;
  }
  return reviewers.has(oxyUserId);
}
