import { Router } from 'express';
import {
  getArtists,
  getArtistById,
  getArtistAlbums,
  getArtistTracks,
} from '../controllers/artists.controller';

const router = Router();

// Public routes only
router.use('/me', (_req, _res, next) => next('router'));
router.get('/', getArtists);
router.get('/:id', getArtistById);
router.get('/:id/albums', getArtistAlbums);
router.get('/:id/tracks', getArtistTracks);

export default router;
