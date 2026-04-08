import { Router } from 'express';
import {
  getUserLibrary,
  getLikedTracks,
  likeTrack,
  unlikeTrack,
} from '../controllers/library.controller';

const router = Router();

// Authenticated routes
router.get('/', getUserLibrary);
router.get('/tracks', getLikedTracks);
router.post('/tracks/:id/like', likeTrack);
router.post('/tracks/:id/unlike', unlikeTrack);

export default router;






