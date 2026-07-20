import { Router } from 'express';
import { reportCopyrightViolation } from '../controllers/copyright.controller';

const router = Router();

// Public route - no authentication required (accessible without sign-in).
// This route is mounted in the public API router, so it works for unauthenticated users.
// Submissions are recorded as CopyrightReport documents and resolved server-side by
// automated processing; there is no human-operated review endpoint.
router.post('/report', reportCopyrightViolation);

export default router;
