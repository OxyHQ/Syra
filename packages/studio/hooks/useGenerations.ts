import { useOxy } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EpisodeGeneration, GenerateEpisodeRequest } from '@syra/shared-types';
import { generationService } from '@/services/generationService';
import { PODCAST_QUERY_KEYS } from '@/hooks/usePodcasts';

const FINISHED: ReadonlySet<EpisodeGeneration['status']> = new Set(['completed', 'failed']);

export const generationsQueryKey = (podcastId: string) =>
  ['studio', 'podcasts', 'generations', podcastId] as const;

/** A show's generated episodes; polled while one is still being made. */
export function useGenerations(podcastId: string | undefined) {
  const { canUsePrivateApi } = useOxy();
  return useQuery({
    queryKey: generationsQueryKey(podcastId ?? ''),
    queryFn: () => generationService.listGenerations(podcastId as string),
    enabled: Boolean(podcastId) && canUsePrivateApi,
    refetchInterval: (query) =>
      query.state.data?.some((generation) => !FINISHED.has(generation.status)) ? 4000 : false,
  });
}

/** Ask for one, then refresh the show (it gained a `processing` episode) and its generations. */
export function useGenerateEpisode(podcastId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: GenerateEpisodeRequest) =>
      generationService.generateEpisode(podcastId, request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: generationsQueryKey(podcastId) });
      queryClient.invalidateQueries({ queryKey: PODCAST_QUERY_KEYS.detail(podcastId) });
      queryClient.invalidateQueries({ queryKey: PODCAST_QUERY_KEYS.mine });
    },
  });
}
