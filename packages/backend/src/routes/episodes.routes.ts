import { Router } from 'express';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';
import {
  getEpisode,
  updateEpisode,
  publishEpisode,
  unpublishEpisode,
  updateEpisodeProgress,
  getContinueListening,
} from '../controllers/episodes.controller';

/**
 * Mounted on the PUBLIC router with optional Oxy auth (server.ts). `/continue`
 * is registered before `/:id` so it is not swallowed by the detail resolver.
 */
const router = Router();

router.get('/continue', requireAuth, getContinueListening);
router.put('/:id/progress', requireAuth, updateEpisodeProgress);
router.patch('/:id', requireAuth, updateEpisode);
router.post('/:id/publish', requireAuth, publishEpisode);
router.post('/:id/unpublish', requireAuth, unpublishEpisode);
router.get('/:id', getEpisode);

export default router;
