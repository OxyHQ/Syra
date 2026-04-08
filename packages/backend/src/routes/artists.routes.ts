import { Router } from 'express';
import {
  getArtists,
  getArtistById,
  getArtistAlbums,
  getArtistTracks,
} from '../controllers/artists.controller';

const router = Router();

// Public routes only
router.get('/', getArtists);
router.get('/:id', getArtistById);
router.get('/:id/albums', getArtistAlbums);
router.get('/:id/tracks', getArtistTracks);

export default router;

