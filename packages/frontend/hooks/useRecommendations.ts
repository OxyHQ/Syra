import { useOxy } from '@oxyhq/services';
import { useQuery } from '@tanstack/react-query';
import { recommendationService } from '@/services/recommendationService';

/**
 * React Query hooks for the recommendation engine.
 *
 * Related artists / similar tracks work for guests too; "Made For You" is
 * personalised and gated to authenticated users. Radio stations are not here —
 * they are stateful and live in {@link file://./useRadio.ts}.
 */

export const RECOMMENDATION_QUERY_KEYS = {
  relatedArtists: (artistId: string) => ['recommendations', 'related-artists', artistId] as const,
  similarTracks: (trackId: string) => ['recommendations', 'similar-tracks', trackId] as const,
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
