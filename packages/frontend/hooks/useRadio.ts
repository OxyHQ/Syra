import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { RadioSeed, RadioSeedType } from '@syra/shared-types';
import { radioService } from '@/services/radioService';
import { useAuthGate, type CatalogIdentity } from '@/hooks/useAuthGate';

/**
 * React Query hooks for Syra Radio.
 *
 * A station is STATEFUL server-side — fetching a page advances its generator
 * and burns catalogue the listener will never be offered again. Pages are
 * therefore never refetched on their own: they go stale only when the station
 * is explicitly reset. The identity segment in the cache key keeps a guest
 * cold-boot station from being served to the authenticated listener that the
 * same app instance resolves into moments later.
 */

export const RADIO_QUERY_KEYS = {
  all: ['radio'] as const,
  station: (identity: CatalogIdentity, seedType: RadioSeedType, seedId: string) =>
    ['radio', 'station', identity, seedType, seedId] as const,
};

/**
 * A station's pages, oldest first. Disabled until the Oxy session reaches a
 * terminal identity, so the first page is always fetched as the right listener.
 */
export function useRadioStation(seed: RadioSeed | null) {
  const { catalogIdentity, isResolved } = useAuthGate();

  return useInfiniteQuery({
    queryKey: RADIO_QUERY_KEYS.station(
      catalogIdentity,
      seed?.seedType ?? 'user',
      seed?.seedId ?? '',
    ),
    queryFn: async ({ pageParam }) => {
      if (!seed) {
        throw new Error('Radio station query ran without a seed');
      }
      return radioService.getPage({
        seedType: seed.seedType,
        seedId: seed.seedId,
        cursor: pageParam ?? undefined,
      });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.cursor,
    enabled: isResolved && seed !== null,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
}

/**
 * Reset a station server-side and drop its cached pages, so the next read
 * rebuilds it from scratch rather than resuming the exhausted generator.
 */
export function useResetRadioStation() {
  const queryClient = useQueryClient();
  const { catalogIdentity } = useAuthGate();

  return useMutation({
    mutationFn: (seed: RadioSeed) => radioService.reset(seed),
    onSuccess: (_result, seed) => {
      queryClient.removeQueries({
        queryKey: RADIO_QUERY_KEYS.station(catalogIdentity, seed.seedType, seed.seedId),
      });
    },
  });
}
