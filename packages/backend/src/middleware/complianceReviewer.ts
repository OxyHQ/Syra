import type { RequestHandler } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { COMPLIANCE_REVIEW_PERMISSION } from '../config/applicationPermissions';
import { oxy } from '../oxyClient';

/**
 * Who may resolve a compliance decision: a person holding Syra's
 * `compliance.review` application permission in Oxy.
 *
 * Two decisions in this codebase are irreversible and carry statutory weight: a
 * copyright report that becomes a takedown (`copyrightRemoved`, a strike, and a
 * purge of every locker holding the same recording), and an artist claim that
 * hands a stranger the profile a real artist's recordings hang from. Neither can
 * be a self-service action.
 *
 * - `fresh: true`: every review request asks Oxy, so a reviewer whose role in
 *   the owning organization was removed stops at once rather than after the 30 s
 *   answer cache.
 * - `deny: 403`: no session answers 401 and a signed-in non-reviewer 403 — "your
 *   session is fine, this decision is not yours to make", which is what a creator
 *   poking at the review queue should learn. An Oxy outage answers 503, never a
 *   "no", and the body is the API error envelope.
 * - FAILS CLOSED: until oxy's first-party registry declares the key for Syra
 *   and the seed has applied it, nobody holds it. Once seeded it is held by the
 *   roles of the owning organization the registry names (oxy ADR 0056); there
 *   are no per-person grants.
 */
export const requireComplianceReviewer: RequestHandler = oxy.middleware.requireAppPermission(
  COMPLIANCE_REVIEW_PERMISSION,
  { fresh: true, deny: 403 },
);

/**
 * The person who made a compliance decision, for the audit record: the operator
 * Oxy resolved from the session, which differs from the caller's user id when a
 * person acts as their organization.
 */
export function complianceReviewerId(req: AuthRequest): string {
  const operatorId = req.oxyAppPermissions?.operatorId;
  if (!operatorId) {
    throw new Error('A compliance decision was reached without requireComplianceReviewer');
  }
  return operatorId;
}
