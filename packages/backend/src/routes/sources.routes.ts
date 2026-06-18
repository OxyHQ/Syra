import { Router } from 'express';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';
import { makeSourcesController } from '../controllers/sources.controller';

const router = Router();
const { searchAudius, addAudiusTrack } = makeSourcesController();

/**
 * GET /api/sources/audius/search
 * Public — browsing is open; optionalAuth is applied at mount point in server.ts.
 * Query: q (required), limit (optional, 1–50, default 20)
 */
router.get('/audius/search', searchAudius);

/**
 * POST /api/sources/audius/add
 * Auth required — adds a found Audius track to the Syra catalog.
 * Body: ExternalTrack (provider='audius', externalId, title, artists[0] required)
 */
router.post('/audius/add', requireAuth, addAudiusTrack);

export default router;
