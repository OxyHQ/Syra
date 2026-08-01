import type { NextFunction, Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { isComplianceReviewer } from '../services/compliance/reviewers';

/**
 * Gate a route behind the compliance reviewer allowlist.
 *
 * Always mounted AFTER `requireOxyAuth`, so an unauthenticated caller gets the
 * SDK's 401 and only an authenticated non-reviewer reaches the 403 here. The two
 * answers are deliberately different: a 403 says "your session is fine, this
 * decision is not yours to make", which is what a signed-in creator poking at the
 * review queue should learn.
 */
export function requireComplianceReviewer(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void {
  const userId = req.user?.id;
  if (!userId || !isComplianceReviewer(userId)) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Compliance review is restricted to platform reviewers',
    });
    return;
  }
  next();
}
