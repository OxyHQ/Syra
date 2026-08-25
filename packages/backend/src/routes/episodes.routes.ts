import { Router } from 'express';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';
import {
  getEpisode,
  updateEpisode,
  publishEpisode,
  unpublishEpisode,
  deleteEpisode,
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
/**
 * Irreversible, and `requireAuth` is not decoration here: this router is mounted
 * under `createOptionalOxyAuth`, so a route WITHOUT it serves unauthenticated
 * callers with `req.user` undefined. The ingest ticket cannot reach this — it is
 * a different header on a different router, and the only handler that reads it
 * writes through an explicit field allowlist that contains no delete.
 */
router.delete('/:id', requireAuth, deleteEpisode);
router.get('/:id', getEpisode);

export default router;
