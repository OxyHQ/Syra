import { Router } from 'express';
import { requireOxyAuth as requireAuth } from '@oxyhq/core/server';
import {
  searchPodcasts,
  discoverPodcasts,
  importPodcast,
  browsePodcasts,
  getPodcast,
  getPodcastEpisodes,
  getPodcastRss,
  subscribePodcast,
  unsubscribePodcast,
  getSubscriptions,
  getMyPodcasts,
  createPodcast,
  uploadEpisode,
  claimPodcast,
} from '../controllers/podcasts.controller';
import {
  getEpisodeAudio,
  getEpisodeStream,
  getEpisodeStreamKey,
  getEpisodeMasterPlaylist,
  getEpisodeVariantPlaylist,
} from '../controllers/podcastAudio.controller';

/**
 * Mounted on the PUBLIC router with optional Oxy auth (server.ts). Reads are
 * public; private/creator routes self-enforce with `requireAuth`. Literal and
 * episode-subresource paths are registered BEFORE `/:id` so Express never
 * misroutes them to the show resolver.
 */
const router = Router();

// Literal collection paths (before /:id)
router.get('/search', searchPodcasts);
router.get('/discover', discoverPodcasts);
router.post('/import', requireAuth, importPodcast);
router.get('/subscriptions', requireAuth, getSubscriptions);
router.get('/mine', requireAuth, getMyPodcasts);

// Episode audio + tokenized HLS stream (3-segment, before /:id and /:id/episodes)
router.get('/episodes/:id/audio', getEpisodeAudio);
router.get('/episodes/:id/stream', getEpisodeStream);
router.get('/episodes/:id/master.m3u8', getEpisodeMasterPlaylist);
router.get('/episodes/:id/v/:variant', getEpisodeVariantPlaylist);
router.get('/episodes/:id/key', getEpisodeStreamKey);

// Browse + create
router.get('/', browsePodcasts);
router.post('/', requireAuth, createPodcast);

// Show subresources
router.get('/:id/episodes', getPodcastEpisodes);
router.get('/:id/rss', getPodcastRss);
router.post('/:id/subscribe', requireAuth, subscribePodcast);
router.post('/:id/unsubscribe', requireAuth, unsubscribePodcast);
router.post('/:id/episodes', requireAuth, uploadEpisode);
router.post('/:id/claim', requireAuth, claimPodcast);

// Show resolver (catch-last)
router.get('/:id', getPodcast);

export default router;
