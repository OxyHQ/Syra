import { useOxy } from '@oxyhq/services';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateArtistRequest } from '@syra/shared-types';
import { artistService, type InsightsPeriod } from '@/services/artistService';

export const MUSIC_QUERY_KEYS = {
  artist: ['studio', 'music', 'artist', 'me'] as const,
  dashboard: ['studio', 'music', 'dashboard'] as const,
  insights: (period: InsightsPeriod) => ['studio', 'music', 'insights', period] as const,
  albums: (artistId: string) => ['studio', 'music', 'albums', artistId] as const,
};

/**
 * The signed-in user's artist profile (or null). Gated on `canUsePrivateApi` so
 * the query waits for the Oxy cold boot to resolve a usable session.
 */
export function useMyArtistProfile() {
  const { canUsePrivateApi } = useOxy();
  return useQuery({
    queryKey: MUSIC_QUERY_KEYS.artist,
    queryFn: () => artistService.getMyArtistProfile(),
    enabled: canUsePrivateApi,
    staleTime: 1000 * 60,
  });
}

/** Register as an artist, then refresh the profile + dashboard. */
export function useRegisterArtist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateArtistRequest) => artistService.registerAsArtist(input),
    onSuccess: (artist) => {
      queryClient.setQueryData(MUSIC_QUERY_KEYS.artist, artist);
      queryClient.invalidateQueries({ queryKey: MUSIC_QUERY_KEYS.dashboard });
    },
  });
}

/** Dashboard rollup for the signed-in artist. */
export function useArtistDashboard(enabled = true) {
  const { canUsePrivateApi } = useOxy();
  return useQuery({
    queryKey: MUSIC_QUERY_KEYS.dashboard,
    queryFn: () => artistService.getArtistDashboard(),
    enabled: enabled && canUsePrivateApi,
    staleTime: 1000 * 30,
  });
}

/** Listener insights for a period. */
export function useArtistInsights(period: InsightsPeriod, enabled = true) {
  const { canUsePrivateApi } = useOxy();
  return useQuery({
    queryKey: MUSIC_QUERY_KEYS.insights(period),
    queryFn: () => artistService.getArtistInsights(period),
    enabled: enabled && canUsePrivateApi,
    staleTime: 1000 * 30,
  });
}
