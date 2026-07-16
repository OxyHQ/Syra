import { useCallback, useMemo } from 'react';
import { z } from 'zod';
import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import type { Podcast, PodcastSubscriptions } from '@syra/shared-types';
import {
  podcastService,
  type BrowsePodcastsParams,
  type PodcastEpisodesPage,
} from '@/services/podcastService';
import {
  episodeService,
  type EpisodeDetail,
  type ContinueListeningEntry,
} from '@/services/episodeService';
import { toast } from '@/lib/sonner';

/**
 * React Query layer for the podcasts vertical.
 *
 * Catalog reads (browse / show / episode list / directory discovery) are public
 * and run for guests too. Identity-scoped data — episode detail (carries the
 * caller's resume position), subscriptions, and "continue listening" — waits for
 * Oxy cold boot (`!isPrivateApiPending`) and keys its cache by identity so a
 * guest response never poisons the authenticated cache.
 */

export const PODCAST_QUERY_KEYS = {
  browse: (params?: BrowsePodcastsParams) => ['podcasts', 'browse', params ?? {}] as const,
  search: (query: string) => ['podcasts', 'search', query] as const,
  show: (id: string) => ['podcasts', 'show', id] as const,
  episodes: (podcastId: string, limit: number) => ['podcasts', 'episodes', podcastId, limit] as const,
  episode: (id: string, identity: string) => ['episodes', 'detail', id, identity] as const,
  subscriptions: ['podcasts', 'subscriptions'] as const,
  continue: ['episodes', 'continue'] as const,
};

// ── Catalog reads (public) ───────────────────────────────────────────────────

export function usePodcasts(params?: BrowsePodcastsParams) {
  return useQuery({
    queryKey: PODCAST_QUERY_KEYS.browse(params),
    queryFn: () => podcastService.browsePodcasts(params),
    staleTime: 1000 * 60 * 5,
  });
}

export function usePodcastSearch(query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: PODCAST_QUERY_KEYS.search(trimmed),
    queryFn: () => podcastService.searchPodcasts(trimmed),
    enabled: trimmed.length > 0,
    staleTime: 1000 * 60 * 2,
  });
}

export function usePodcast(id: string | undefined) {
  return useQuery({
    queryKey: PODCAST_QUERY_KEYS.show(id ?? ''),
    queryFn: () => podcastService.getPodcast(id as string),
    enabled: Boolean(id),
    staleTime: 1000 * 60 * 5,
  });
}

export function useEpisodes(podcastId: string | undefined, limit = 50) {
  return useQuery<PodcastEpisodesPage>({
    queryKey: PODCAST_QUERY_KEYS.episodes(podcastId ?? '', limit),
    queryFn: () => podcastService.getPodcastEpisodes(podcastId as string, { limit }),
    enabled: Boolean(podcastId),
    staleTime: 1000 * 60 * 5,
  });
}

// ── Episode detail (identity-scoped) ─────────────────────────────────────────

export function useEpisode(id: string | undefined) {
  // Episode content is public + identity-independent (read via publicApi), so it
  // does NOT wait on the Oxy cold boot — it loads as soon as we have an id, even
  // for guests or while a session is still settling.
  return useQuery<EpisodeDetail>({
    queryKey: PODCAST_QUERY_KEYS.episode(id ?? '', 'public'),
    queryFn: () => episodeService.getEpisode(id as string),
    enabled: Boolean(id),
    staleTime: 1000 * 60,
  });
}

// ── Subscriptions ────────────────────────────────────────────────────────────

export function useSubscriptions() {
  const { canUsePrivateApi } = useOxy();
  return useQuery<PodcastSubscriptions>({
    queryKey: PODCAST_QUERY_KEYS.subscriptions,
    queryFn: () => podcastService.getSubscriptions(),
    enabled: canUsePrivateApi,
    staleTime: 1000 * 60 * 5,
  });
}

/** O(1) lookup of whether a show is subscribed, derived from the cache. */
export function useIsSubscribed() {
  const { data } = useSubscriptions();
  const ids = useMemo(
    () => new Set((data?.subscriptions ?? []).map((entry) => entry.podcast.id)),
    [data],
  );
  return useCallback((podcastId: string) => ids.has(podcastId), [ids]);
}

interface ToggleSubscriptionVariables {
  podcastId: string;
  next: boolean;
  podcast?: Podcast;
}

interface ToggleSubscriptionContext {
  previous: PodcastSubscriptions | undefined;
}

const EMPTY_SUBSCRIPTIONS: PodcastSubscriptions = { subscriptions: [], total: 0, oxyUserId: '' };

/**
 * Subscribe / unsubscribe with an optimistic patch of the subscriptions cache,
 * so the Subscribe button and the library list flip instantly and reconcile
 * with the server on settle.
 */
export function useToggleSubscription(): UseMutationResult<void, Error, ToggleSubscriptionVariables, ToggleSubscriptionContext> {
  const queryClient = useQueryClient();
  const { canUsePrivateApi, openAccountDialog } = useOxy();

  return useMutation<void, Error, ToggleSubscriptionVariables, ToggleSubscriptionContext>({
    mutationFn: ({ podcastId, next }) => {
      if (!canUsePrivateApi) {
        openAccountDialog('signin');
        throw new Error('Sign in to subscribe to podcasts');
      }
      return next ? podcastService.subscribe(podcastId) : podcastService.unsubscribe(podcastId);
    },
    onMutate: async ({ podcastId, next, podcast }) => {
      if (!canUsePrivateApi) {
        return { previous: queryClient.getQueryData<PodcastSubscriptions>(PODCAST_QUERY_KEYS.subscriptions) };
      }
      await queryClient.cancelQueries({ queryKey: PODCAST_QUERY_KEYS.subscriptions });
      const previous = queryClient.getQueryData<PodcastSubscriptions>(PODCAST_QUERY_KEYS.subscriptions);
      queryClient.setQueryData<PodcastSubscriptions>(PODCAST_QUERY_KEYS.subscriptions, (current) => {
        const base = current ?? EMPTY_SUBSCRIPTIONS;
        const without = base.subscriptions.filter((entry) => entry.podcast.id !== podcastId);
        if (!next) {
          return { ...base, subscriptions: without, total: without.length };
        }
        const show = podcast ?? base.subscriptions.find((entry) => entry.podcast.id === podcastId)?.podcast;
        const nextSubscriptions = show
          ? [{ podcast: show, subscribedAt: new Date().toISOString() }, ...without]
          : without;
        return { ...base, subscriptions: nextSubscriptions, total: nextSubscriptions.length };
      });
      return { previous };
    },
    onError: (error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(PODCAST_QUERY_KEYS.subscriptions, context.previous);
      }
      toast.error(error.message || 'Could not update your subscriptions');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: PODCAST_QUERY_KEYS.subscriptions });
    },
  });
}

// ── Continue listening + progress ────────────────────────────────────────────

export function useContinueListening() {
  const { canUsePrivateApi } = useOxy();
  return useQuery<ContinueListeningEntry[]>({
    queryKey: PODCAST_QUERY_KEYS.continue,
    queryFn: () => episodeService.getContinueListening(),
    enabled: canUsePrivateApi,
    staleTime: 1000 * 30,
  });
}

export interface EpisodeProgressSnapshot {
  progressSec: number;
  durationSec: number;
  completed: boolean;
}

/** Map of episodeId → saved progress, derived from the continue-listening cache. */
export function useEpisodeProgressMap(): Map<string, EpisodeProgressSnapshot> {
  const { data } = useContinueListening();
  return useMemo(() => {
    const map = new Map<string, EpisodeProgressSnapshot>();
    for (const entry of data ?? []) {
      map.set(entry.episode.id, {
        progressSec: entry.progressSec,
        durationSec: entry.durationSec,
        completed: entry.completed,
      });
    }
    return map;
  }, [data]);
}

/** Saved progress for a single episode (resume position / played dot source). */
export function useEpisodeProgress(episodeId: string | undefined): EpisodeProgressSnapshot | undefined {
  const map = useEpisodeProgressMap();
  return episodeId ? map.get(episodeId) : undefined;
}

// ── Chapters (Podcasting 2.0) ────────────────────────────────────────────────

export interface EpisodeChapter {
  startTime: number;
  title?: string;
  img?: string;
  url?: string;
}

const chaptersDocumentSchema = z.object({
  chapters: z.array(z.object({
    startTime: z.number(),
    title: z.string().optional(),
    img: z.string().optional(),
    url: z.string().optional(),
  }).passthrough()),
}).passthrough();

/**
 * Fetch + parse a Podcasting 2.0 chapters file (`episode.chapters.url`).
 * The URL is an external (publisher) resource, so it is fetched directly.
 */
export function useEpisodeChapters(url: string | undefined) {
  return useQuery<EpisodeChapter[]>({
    queryKey: ['episodes', 'chapters', url ?? ''],
    queryFn: async () => {
      const response = await fetch(url as string);
      if (!response.ok) {
        throw new Error(`Failed to load chapters (${response.status})`);
      }
      const parsed = chaptersDocumentSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error('Invalid chapters document');
      }
      return parsed.data.chapters;
    },
    enabled: Boolean(url),
    staleTime: 1000 * 60 * 60,
  });
}
