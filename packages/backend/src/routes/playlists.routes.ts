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
import { validate } from '../middleware/validate';
import { withDb } from '../utils/withDb';
import {
  createPlaylistRequestSchema,
  updatePlaylistRequestSchema,
  addTracksToPlaylistBodySchema,
  removeTracksFromPlaylistBodySchema,
  reorderPlaylistTracksBodySchema,
} from '@syra/shared-types';

const router = Router();

// Public routes
router.get('/:id', withDb(getPlaylistById));
router.get('/:id/tracks', withDb(getPlaylistTracks));

// Authenticated routes
router.use(requireAuth);
router.get('/', withDb(getUserPlaylists));
router.post('/', singleCoverArtUpload, validate({ body: createPlaylistRequestSchema }), withDb(createPlaylist));
router.put('/:id', singleCoverArtUpload, validate({ body: updatePlaylistRequestSchema }), withDb(updatePlaylist));
router.delete('/:id', withDb(deletePlaylist));
router.post('/:id/tracks', validate({ body: addTracksToPlaylistBodySchema }), withDb(addTracksToPlaylist));
router.delete('/:id/tracks', validate({ body: removeTracksFromPlaylistBodySchema }), withDb(removeTracksFromPlaylist));
router.put('/:id/tracks/reorder', validate({ body: reorderPlaylistTracksBodySchema }), withDb(reorderPlaylistTracks));

export default router;

