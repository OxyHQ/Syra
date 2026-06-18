import { Router } from 'express';
import {
  reportCopyrightViolation,
  getCopyrightReports,
  approveCopyrightReport,
  rejectCopyrightReport,
} from '../controllers/copyright.controller';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';

const router = Router();

// Public route - no authentication required (accessible without sign-in)
// This route is mounted in the public API router, so it works for unauthenticated users
router.post('/report', reportCopyrightViolation);

// Admin routes - require authentication
router.get('/reports', requireAuth, getCopyrightReports);
router.post('/reports/:id/approve', requireAuth, approveCopyrightReport);
router.post('/reports/:id/reject', requireAuth, rejectCopyrightReport);

export default router;

