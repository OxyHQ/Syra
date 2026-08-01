import { Router } from 'express';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';
import {
  reportCopyrightViolation,
  listCopyrightReports,
  resolveCopyrightReport,
} from '../controllers/copyright.controller';
import { requireComplianceReviewer } from '../middleware/complianceReviewer';

const router = Router();

/**
 * Mounted ONCE, on the public API router behind optional auth — the podcasts
 * pattern. It used to be mounted on the public router AND the authenticated one,
 * which reads like "both audiences are served" and is not what Express does: the
 * public mount is registered first and matches first, so the authenticated mount
 * was unreachable and `reporterOxyUserId` was recorded as undefined for every
 * report, including those filed by a signed-in user. Optional auth resolves the
 * reporter when there is one; the routes below self-enforce what they need.
 */

// Anyone, signed in or not — a rightsholder may have no Syra account at all.
router.post('/report', reportCopyrightViolation);

/**
 * The review queue and the decision that acts on it.
 *
 * Reviewer-gated rather than open, because approving a report is a takedown:
 * irreversible removal, a purge of every private locker holding the same
 * recording, and a strike that terminates the account at three.
 */
router.get('/reports', requireAuth, requireComplianceReviewer, listCopyrightReports);
router.post('/reports/:id/resolve', requireAuth, requireComplianceReviewer, resolveCopyrightReport);

export default router;
