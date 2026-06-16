import { Router } from 'express';
import {
  getUserLibrary,
  getLikedTracks,
  likeTrack,
  unlikeTrack,
  saveAlbum,
  unsaveAlbum,
  followArtist,
  unfollowArtist,
  savePlaylist,
  unsavePlaylist,
  getRecentlyPlayed,
  recordRecentlyPlayed,
} from '../controllers/library.controller';

const router = Router();

// Authenticated routes (mounted behind oxy.auth() at /api/library)
router.get('/', getUserLibrary);
router.get('/tracks', getLikedTracks);

router.get('/recently-played', getRecentlyPlayed);
router.post('/recently-played', recordRecentlyPlayed);

router.post('/tracks/:id/like', likeTrack);
router.post('/tracks/:id/unlike', unlikeTrack);

router.post('/albums/:id/save', saveAlbum);
router.post('/albums/:id/unsave', unsaveAlbum);

router.post('/artists/:id/follow', followArtist);
router.post('/artists/:id/unfollow', unfollowArtist);

router.post('/playlists/:id/save', savePlaylist);
router.post('/playlists/:id/unsave', unsavePlaylist);

export default router;
