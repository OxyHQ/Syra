import { useMemo } from 'react';
import { usePlayerStore } from '@/stores/playerStore';
import { pickCatalogImageUrl, resolvePodcastArtwork } from '@/utils/pickImage';
import { trackArtistsText } from '@/utils/trackArtists';

/**
 * Unified now-playing view model so the player bars and the now-playing panel
 * can render either a music track or a podcast episode without each duplicating
 * the track-vs-episode branching.
 */
export interface NowPlayingMedia {
  kind: 'track' | 'episode';
  id: string;
  title: string;
  subtitle: string;
  imageUri?: string;
}

export function useNowPlayingMedia(): NowPlayingMedia | null {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const currentEpisode = usePlayerStore((s) => s.currentEpisode);

  return useMemo<NowPlayingMedia | null>(() => {
    if (currentEpisode) {
      return {
        kind: 'episode',
        id: currentEpisode.id,
        title: currentEpisode.title,
        subtitle: currentEpisode.podcastTitle,
        imageUri: resolvePodcastArtwork(currentEpisode, 'thumbnail'),
      };
    }
    if (currentTrack) {
      return {
        kind: 'track',
        id: currentTrack.id,
        title: currentTrack.title || currentTrack.artistName || 'Untitled track',
        // The whole credit, not the owning artist alone — the player bars render
        // this as one line and a record by two people must not show one name.
        subtitle: trackArtistsText(currentTrack, ''),
        imageUri: pickCatalogImageUrl(
          currentTrack.images,
          currentTrack.coverArt,
          'thumbnail',
          currentTrack.coverArtSizes,
        ),
      };
    }
    return null;
  }, [currentTrack, currentEpisode]);
}
