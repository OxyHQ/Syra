import { Router, Response } from 'express';
import { requireOxyAuth as requireAuth, type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';
import { sendErrorResponse, sendSuccessResponse } from '../utils/apiHelpers';
import { getRequiredOxyUserId as getAuthenticatedUserId } from '@oxyhq/core/server';
import {
  coerceMusicPreferencesPatch,
  ensureMusicPreferences,
  updateMusicPreferences,
} from '../db/user/musicPreferences';

const router = Router();

/**
 * Music Preferences API
 * All routes require authentication
 *
 * ## The 400 branch is gone, and it had to be
 *
 * `PUT` used to answer 400 when the caught error's `.message` contained the
 * substring "validation", and put that message in the response body. Both halves
 * stop working at the port: Mongoose document validation is what produced those
 * messages, and a postgres.js error's `.message` carries the failing statement
 * and its bound parameters, so echoing it would put the SQL on the wire.
 *
 * Nothing reachable is lost. Every field is clamped into its column's CHECK
 * range by `coerceMusicPreferencesPatch` and anything of the wrong type is
 * dropped, so a well-formed request cannot be refused by the database and a
 * malformed one is ignored field by field — which is what the Mongo route did
 * with it too.
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
    logger.error('[MusicPreferences] Error fetching preferences:', describeErrorSafely(err));
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
    const updatedPreferences = await updateMusicPreferences(
      oxyUserId,
      coerceMusicPreferencesPatch(req.body)
    );
    return sendSuccessResponse(res, 200, updatedPreferences);
  } catch (err) {
    logger.error('[MusicPreferences] Error updating preferences:', describeErrorSafely(err));
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to update music preferences');
  }
});

export default router;
