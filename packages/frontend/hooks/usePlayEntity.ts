import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { musicService } from '@/services/musicService';
import { podcastService } from '@/services/podcastService';
import { usePlayerStore } from '@/stores/playerStore';
import { toast } from '@/lib/sonner';
import { createScopedLogger } from '@/utils/logger';

const logger = createScopedLogger('PlayEntity');

/** Tracks pulled for an artist's play button — one screen's worth of listening. */
const ARTIST_TRACK_LIMIT = 50;

export interface PlayEntity {
  playAlbum: (albumId: string, albumName?: string) => Promise<void>;
  playPlaylist: (playlistId: string, playlistName?: string) => Promise<void>;
  playArtist: (artistId: string, artistName?: string) => Promise<void>;
  /** Plays the show's most recent episode, the way "continue listening" plays one. */
  playPodcast: (podcastId: string, podcastTitle?: string) => Promise<void>;
}

/**
 * Turns "play this album / playlist / artist / show" into real playback.
 *
 * A card only knows an entity id, but playing one means fetching its tracks and
 * making them the queue. Home, search, the artist profile, the podcasts browse
 * screen and the top bar's search results all need exactly that, so it lives
 * here instead of being re-implemented (and drifting) on each screen.
 *
 * Failures that belong to THIS step — the fetch, or an entity with nothing
 * playable in it — are reported here. Failures of the playback that follows are
 * reported by the player store itself, which every play path already funnels
 * through, so they are deliberately not caught again here.
 */
export function usePlayEntity(): PlayEntity {
  const { t } = useTranslation();
  const playTrackList = usePlayerStore((state) => state.playTrackList);
  const playEpisodeList = usePlayerStore((state) => state.playEpisodeList);

  const playAlbum = useCallback(async (albumId: string, albumName?: string) => {
    try {
      const { tracks } = await musicService.getAlbumTracks(albumId);
      if (tracks.length === 0) {
        toast.info(t('common.noPlayableTracks'));
        return;
      }
      await playTrackList(tracks, 0, { type: 'album', id: albumId, name: albumName });
    } catch (error) {
      logger.error('Error playing album', { albumId, error });
      toast.error(t('common.playbackFailed'));
    }
  }, [playTrackList, t]);

  const playPlaylist = useCallback(async (playlistId: string, playlistName?: string) => {
    try {
      const { tracks } = await musicService.getPlaylistTracks(playlistId);
      if (tracks.length === 0) {
        toast.info(t('common.noPlayableTracks'));
        return;
      }
      await playTrackList(tracks, 0, { type: 'playlist', id: playlistId, name: playlistName });
    } catch (error) {
      logger.error('Error playing playlist', { playlistId, error });
      toast.error(t('common.playbackFailed'));
    }
  }, [playTrackList, t]);

  const playArtist = useCallback(async (artistId: string, artistName?: string) => {
    try {
      const { tracks } = await musicService.getArtistTracks(artistId, { limit: ARTIST_TRACK_LIMIT });
      if (tracks.length === 0) {
        toast.info(t('common.noPlayableTracks'));
        return;
      }
      await playTrackList(tracks, 0, { type: 'artist', id: artistId, name: artistName });
    } catch (error) {
      logger.error('Error playing artist', { artistId, error });
      toast.error(t('common.playbackFailed'));
    }
  }, [playTrackList, t]);

  const playPodcast = useCallback(async (podcastId: string, podcastTitle?: string) => {
    try {
      // Episodes come back reverse-chronological, so the first is the latest —
      // which is what a listener pressing play on a show expects to hear.
      const { episodes } = await podcastService.getPodcastEpisodes(podcastId, { limit: 1 });
      if (episodes.length === 0) {
        toast.info(t('common.noPlayableTracks'));
        return;
      }
      await playEpisodeList(episodes, 0, { type: 'podcast', id: podcastId, name: podcastTitle });
    } catch (error) {
      logger.error('Error playing podcast', { podcastId, error });
      toast.error(t('common.playbackFailed'));
    }
  }, [playEpisodeList, t]);

  return { playAlbum, playPlaylist, playArtist, playPodcast };
}
