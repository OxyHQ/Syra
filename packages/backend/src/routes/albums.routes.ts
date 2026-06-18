import { Router } from 'express';
import {
  getAlbums,
  getAlbumById,
  getAlbumTracks,
  createAlbum,
} from '../controllers/albums.controller';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';
import { singleCoverArtUpload } from '../utils/imageUpload';

const router = Router();

// Public routes
router.get('/', getAlbums);
router.get('/:id', getAlbumById);
router.get('/:id/tracks', getAlbumTracks);

// Authenticated routes
// Accept optional coverArt image file upload via multer
router.post('/', requireAuth, singleCoverArtUpload, createAlbum);

export default router;

