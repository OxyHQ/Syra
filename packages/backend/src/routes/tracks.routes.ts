import { Router } from 'express';
import {
  getTracks,
  getTrackById,
  searchTracks,
  updateTrack,
  uploadTrack,
} from '../controllers/tracks.controller';
import { getSimilarTracksHandler } from '../controllers/recommendations.controller';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';

const router = Router();

// Public routes
router.get('/', getTracks);
router.get('/search', searchTracks);
router.get('/:id', getTrackById);
router.get('/:id/similar', getSimilarTracksHandler);

// Authenticated routes
router.post('/upload', requireAuth, uploadTrack);
router.patch('/:id', requireAuth, updateTrack);

export default router;

