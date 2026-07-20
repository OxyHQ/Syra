import { Router } from 'express';
import {
  followArtist,
  unfollowArtist,
  registerAsArtist,
  getMyArtistProfile,
  updateMyArtistProfile,
  getArtistDashboard,
  getArtistInsights,
} from '../controllers/artists.controller';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';
import { singleImageUpload } from '../utils/imageUpload';

const router = Router();

// Artist management routes (authenticated) - Must be before /:id routes!
// Accept optional image file upload via multer
router.post('/register', requireAuth, singleImageUpload, registerAsArtist);
router.get('/me', requireAuth, getMyArtistProfile);
router.patch('/me', requireAuth, updateMyArtistProfile);
router.get('/me/dashboard', requireAuth, getArtistDashboard);
router.get('/me/insights', requireAuth, getArtistInsights);

// Authenticated routes for following/unfollowing
router.post('/:id/follow', requireAuth, followArtist);
router.post('/:id/unfollow', requireAuth, unfollowArtist);

export default router;




