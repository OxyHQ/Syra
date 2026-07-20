import { Router } from 'express';
import {
  getAlbums,
  getAlbumById,
  getAlbumTracks,
  createAlbum,
  updateAlbum,
  publishAlbum,
  unpublishAlbum,
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
router.patch('/:id', requireAuth, updateAlbum);
router.post('/:id/publish', requireAuth, publishAlbum);
router.post('/:id/unpublish', requireAuth, unpublishAlbum);

export default router;

