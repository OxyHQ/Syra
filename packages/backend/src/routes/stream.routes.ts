import { Router } from 'express';
import { getStream, getStreamKey } from '../controllers/stream.controller';

const router = Router();

/**
 * Stream routes are mounted on the PUBLIC router with `optionalAuth` (server.ts).
 * Each handler self-enforces authorization:
 *   - GET /:trackId       — requires bearer session (issues tokens)
 *   - GET /:trackId/key   — accepts bearer OR valid ?t= stream token bound to trackId
 *
 * 3.4 manifest routes (master.m3u8, :rendition/index.m3u8) will be added here.
 */
router.get('/:trackId/key', getStreamKey);
router.get('/:trackId', getStream);

export default router;
