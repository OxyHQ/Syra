import { Router } from 'express';
import {
  reportCopyrightViolation,
  getCopyrightReports,
  approveCopyrightReport,
  rejectCopyrightReport,
} from '../controllers/copyright.controller';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';
import { requireCopyrightAdmin } from '../middleware/copyrightAdmin';

const router = Router();

// Public route - no authentication required (accessible without sign-in)
// This route is mounted in the public API router, so it works for unauthenticated users
router.post('/report', reportCopyrightViolation);

// Admin routes - require authentication and explicit copyright admin allowlist membership
router.get('/reports', requireAuth, requireCopyrightAdmin, getCopyrightReports);
router.post('/reports/:id/approve', requireAuth, requireCopyrightAdmin, approveCopyrightReport);
router.post('/reports/:id/reject', requireAuth, requireCopyrightAdmin, rejectCopyrightReport);

export default router;

