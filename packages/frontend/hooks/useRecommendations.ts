import { useOxy } from '@oxyhq/services';
import { useQuery } from '@tanstack/react-query';
import { recommendationService } from '@/services/recommendationService';

/**
 * React Query hooks for the recommendation engine.
 *
 * Related artists / similar tracks / radio are public (work for guests too);
 * "Made For You" is personalised and gated to authenticated users.
 */

export const RECOMMENDATION_QUERY_KEYS = {
  relatedArtists: (artistId: string) => ['recommendations', 'related-artists', artistId] as const,
  similarTracks: (trackId: string) => ['recommendations', 'similar-tracks', trackId] as const,
  trackRadio: (trackId: string) => ['recommendations', 'track-radio', trackId] as const,
  madeForYou: ['recommendations', 'made-for-you'] as const,
};

/** Artists fans of this artist also listen to (for the artist screen). */
export function useRelatedArtists(artistId: string | undefined, limit = 20) {
  return useQuery({
    queryKey: RECOMMENDATION_QUERY_KEYS.relatedArtists(artistId ?? ''),
    queryFn: () => recommendationService.getRelatedArtists(artistId as string, { limit }),
    enabled: Boolean(artistId),
    staleTime: 1000 * 60 * 30,
  });
}

/** Tracks similar to this one (for the track / now-playing screen). */
export function useSimilarTracks(trackId: string | undefined, limit = 20) {
  return useQuery({
    queryKey: RECOMMENDATION_QUERY_KEYS.similarTracks(trackId ?? ''),
    queryFn: () => recommendationService.getSimilarTracks(trackId as string, { limit }),
    enabled: Boolean(trackId),
    staleTime: 1000 * 60 * 30,
  });
}

/** A radio station seeded from a track (for "start radio" actions). */
export function useTrackRadio(trackId: string | undefined, limit = 30) {
  return useQuery({
    queryKey: RECOMMENDATION_QUERY_KEYS.trackRadio(trackId ?? ''),
    queryFn: () => recommendationService.getTrackRadio(trackId as string, { limit }),
    enabled: Boolean(trackId),
    staleTime: 1000 * 60 * 10,
  });
}

/** Personalised "Made For You" for the signed-in user. */
export function useMadeForYouRecommendations(limit = 20) {
  const { canUsePrivateApi } = useOxy();
  return useQuery({
    queryKey: RECOMMENDATION_QUERY_KEYS.madeForYou,
    queryFn: () => recommendationService.getMadeForYou({ limit }),
    enabled: canUsePrivateApi,
    staleTime: 1000 * 60 * 5,
  });
}
