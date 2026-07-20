import { useMemo } from 'react';
import { usePlayerStore } from '@/stores/playerStore';
import { pickCatalogImageUrl } from '@/utils/pickImage';

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
        imageUri: pickCatalogImageUrl(
          undefined,
          currentEpisode.image,
          'thumbnail',
          currentEpisode.imageSizes,
          currentEpisode.imageSourceUrl,
        ),
      };
    }
    if (currentTrack) {
      return {
        kind: 'track',
        id: currentTrack.id,
        title: currentTrack.title || currentTrack.artistName || 'Untitled track',
        subtitle: currentTrack.artistName || '',
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
