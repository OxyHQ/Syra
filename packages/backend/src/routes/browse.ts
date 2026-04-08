import express from 'express';
import {
  getGenres,
  getPopularTracks,
  getPopularAlbums,
  getPopularArtists,
  getMadeForYou,
  getCharts,
} from '../controllers/browse.controller';

const router = express.Router();

/**
 * Browse/Explore API routes
 */
router.get('/genres', getGenres);
router.get('/popular/tracks', getPopularTracks);
router.get('/popular/albums', getPopularAlbums);
router.get('/popular/artists', getPopularArtists);
router.get('/made-for-you', getMadeForYou);
router.get('/charts', getCharts);

export default router;






