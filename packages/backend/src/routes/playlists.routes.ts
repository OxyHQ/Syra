import { Router } from 'express';
import {
  getUserPlaylists,
  getPlaylistById,
  getPlaylistTracks,
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  addTracksToPlaylist,
  removeTracksFromPlaylist,
  reorderPlaylistTracks,
} from '../controllers/playlists.controller';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';
import { singleCoverArtUpload } from '../utils/imageUpload';

const router = Router();

// Public routes
router.get('/:id', getPlaylistById);
router.get('/:id/tracks', getPlaylistTracks);

// Authenticated routes
router.use(requireAuth);
router.get('/', getUserPlaylists);
router.post('/', singleCoverArtUpload, createPlaylist);
router.put('/:id', singleCoverArtUpload, updatePlaylist);
router.delete('/:id', deletePlaylist);
router.post('/:id/tracks', addTracksToPlaylist);
router.delete('/:id/tracks', removeTracksFromPlaylist);
router.put('/:id/tracks/reorder', reorderPlaylistTracks);

export default router;

