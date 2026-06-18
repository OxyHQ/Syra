import { Router } from 'express';
import {
  getTracks,
  getTrackById,
  searchTracks,
  uploadTrack,
} from '../controllers/tracks.controller';
import {
  getSimilarTracksHandler,
  getTrackRadioHandler,
} from '../controllers/recommendations.controller';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';

const router = Router();

// Public routes
router.get('/', getTracks);
router.get('/search', searchTracks);
router.get('/:id', getTrackById);
router.get('/:id/similar', getSimilarTracksHandler);
router.get('/:id/radio', getTrackRadioHandler);

// Authenticated routes
router.post('/upload', requireAuth, uploadTrack);

export default router;

