import { useOxy } from '@oxyhq/services';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatePodcastRequest } from '@syra/shared-types';
import { podcastService } from '@/services/podcastService';
import { episodeService, type EpisodeAudioFile, type UploadEpisodeMetadata } from '@/services/episodeService';

export const PODCAST_QUERY_KEYS = {
  mine: ['studio', 'podcasts', 'mine'] as const,
  detail: (id: string) => ['studio', 'podcasts', 'detail', id] as const,
  episodes: (id: string) => ['studio', 'podcasts', 'episodes', id] as const,
};

/**
 * Shows owned by the signed-in creator. Gated on `canUsePrivateApi` so the query
 * waits for the Oxy cold boot to resolve a usable session before firing.
 */
export function useMyPodcasts() {
  const { canUsePrivateApi } = useOxy();
  return useQuery({
    queryKey: PODCAST_QUERY_KEYS.mine,
    queryFn: () => podcastService.getMyPodcasts(),
    enabled: canUsePrivateApi,
    staleTime: 1000 * 60,
  });
}

/** A single show plus its recent episodes. */
export function usePodcast(id: string | undefined) {
  const { canUsePrivateApi } = useOxy();
  return useQuery({
    queryKey: PODCAST_QUERY_KEYS.detail(id ?? ''),
    queryFn: () => podcastService.getPodcast(id as string),
    enabled: Boolean(id) && canUsePrivateApi,
    staleTime: 1000 * 30,
  });
}

/** A reverse-chronological page of a show's episodes. */
export function usePodcastEpisodes(id: string | undefined, params?: { page?: number; limit?: number }) {
  const { canUsePrivateApi } = useOxy();
  return useQuery({
    queryKey: [...PODCAST_QUERY_KEYS.episodes(id ?? ''), params?.page ?? 1, params?.limit ?? 50] as const,
    queryFn: () => podcastService.getEpisodes(id as string, params),
    enabled: Boolean(id) && canUsePrivateApi,
    staleTime: 1000 * 30,
  });
}

/** Create a new Syra-hosted show, then refresh the dashboard list. */
export function useCreatePodcast() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePodcastRequest) => podcastService.createPodcast(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PODCAST_QUERY_KEYS.mine });
    },
  });
}

export interface UploadEpisodeVariables {
  podcastId: string;
  audioFile: EpisodeAudioFile;
  metadata: UploadEpisodeMetadata;
}

/** Upload an episode, then refresh the show detail + episode list it belongs to. */
export function useUploadEpisode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ podcastId, audioFile, metadata }: UploadEpisodeVariables) =>
      episodeService.uploadEpisode(podcastId, audioFile, metadata),
    onSuccess: (_episode, { podcastId }) => {
      queryClient.invalidateQueries({ queryKey: PODCAST_QUERY_KEYS.detail(podcastId) });
      queryClient.invalidateQueries({ queryKey: PODCAST_QUERY_KEYS.episodes(podcastId) });
      queryClient.invalidateQueries({ queryKey: PODCAST_QUERY_KEYS.mine });
    },
  });
}
