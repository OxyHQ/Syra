import { Router, Response } from 'express';
import { AuthRequest, requireAuth } from '../middleware/auth';
import { sendErrorResponse, sendSuccessResponse } from '../utils/apiHelpers';
import { getAuthenticatedUserId } from '../utils/auth';
import {
  getMusicPreferences,
  updateMusicPreferences,
  ensureMusicPreferences,
} from '../controllers/musicPreferences.controller';

const router = Router();

/**
 * Music Preferences API
 * All routes require authentication
 */

// Apply auth middleware to all routes
router.use(requireAuth);

/**
 * GET /api/music/preferences/me
 * Get current user's music preferences
 */
router.get('/preferences/me', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const preferences = await ensureMusicPreferences(oxyUserId);
    return sendSuccessResponse(res, 200, preferences);
  } catch (err) {
    console.error('[MusicPreferences] Error fetching preferences:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to fetch music preferences');
  }
});

/**
 * PUT /api/music/preferences
 * Update current user's music preferences
 */
router.put('/preferences', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const updatedPreferences = await updateMusicPreferences(oxyUserId, req.body);
    return sendSuccessResponse(res, 200, updatedPreferences);
  } catch (err: any) {
    console.error('[MusicPreferences] Error updating preferences:', err);
    if (err.message && err.message.includes('validation')) {
      return sendErrorResponse(res, 400, 'Bad Request', err.message);
    }
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to update music preferences');
  }
});

export default router;






