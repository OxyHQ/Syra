import { ReportStatus } from './types';

/**
 * Syra's verdict axis, derived from a decision and nowhere else.
 *
 * The OTHER axis — `localStatus`, "did the report get out of here and come
 * back" — belongs to `@oxyhq/crowdsource-app` and is written by it. This one is
 * Syra's, it existed before Syra adopted CrowdSource, and it reaches the same
 * update through the integration's `reportDecisionExtraFields` hook, which the
 * package provides for exactly this case.
 *
 * Two status fields maintained by two call sites is how they drift, so both are
 * derived from the decision and neither from the other.
 *
 * The mapping is deliberately conservative about the difference between "a jury
 * looked at this" and "this was a violation". `resolved` and `dismissed` are the
 * two values that carry a verdict, so only an outcome that IS a verdict may
 * produce them:
 *
 * - `violation` → `resolved`: the case reached a conclusion Syra can act on.
 * - `no_violation` → `dismissed`: the allegation was not upheld.
 * - `insufficient_context`, `inconclusive`, `content_unavailable`, `duplicate`,
 *   `escalated` → `reviewed`: a jury engaged and produced no verdict. Mapping any
 *   of these to `dismissed` would turn "we could not tell" into "nothing was
 *   wrong", which is the exact collapse the invariants forbid — absence of
 *   consensus is neither guilt nor innocence.
 *
 * An outcome this version does not know also maps to `reviewed`: a newer
 * CrowdSource must not be able to silently produce `dismissed` here.
 *
 * The outcome is a plain STRING on purpose. It is reached with a value that came
 * off the wire, and an unrecognised outcome must be handled rather than throw.
 */
export function legacyStatusForOutcome(outcome: string): ReportStatus {
  switch (outcome) {
    case 'violation':
      return ReportStatus.RESOLVED;
    case 'no_violation':
      return ReportStatus.DISMISSED;
    default:
      return ReportStatus.REVIEWED;
  }
}
