import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { getStreamKey } from '../controllers/stream.controller';

const router = Router();

/** All stream routes require a verified session. */
router.use(requireAuth);

/** GET /:trackId/key — serve the raw AES-128 key for an HLS stream. */
router.get('/:trackId/key', getStreamKey);

export default router;
