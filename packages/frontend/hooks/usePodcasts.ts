import { useMemo } from 'react';
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
import {
  LIBRARY_QUERY_KEY,
  useLibrary,
  withMembership,
} from '@/hooks/useLibrary';
import type { LibraryMembership } from '@/services/libraryService';
import { toast } from '@oxyhq/bloom/toast';

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
  mine: ['podcasts', 'mine'] as const,
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

/**
 * O(1) lookup of whether a show is subscribed.
 *
 * Derived from the shared `['library']` MEMBERSHIP cache, not from the hydrated
 * subscriptions list, and the two are not interchangeable: membership is one
 * cheap id array shared with every like/save/follow control in the app and it is
 * already loaded by the time any screen renders, while `useSubscriptions` is a
 * page of full show DTOs the podcast surfaces fetch for their own list. Reading
 * button state off the heavy one meant the Subscribe button could not answer
 * until that page arrived, and it made subscription state the one membership
 * with a second source of truth.
 */
export function useIsSubscribed() {
  const { isPodcastSubscribed } = useLibrary();
  return isPodcastSubscribed;
}

/**
 * The shows the signed-in user OWNS — their own library section, distinct from
 * what they subscribe to.
 *
 * Not folded into {@link useSubscriptions}: a show you MADE and a show you
 * FOLLOW are different relationships with opposite lifecycles (one is a property
 * of the show row and cannot be removed by the viewer, the other is a saved id
 * that drops out the moment the show stops being readable), and the backend
 * serializes them differently in the same response — an owned show carries its
 * `feedUrl`, its crawler bookkeeping and its TRUE `episodeCount` including
 * unpublished episodes, where a subscribed one is served the ready-episode
 * count. One list under one heading would silently mix the two.
 */
export function useMyPodcasts() {
  const { canUsePrivateApi } = useOxy();
  return useQuery<Podcast[]>({
    queryKey: PODCAST_QUERY_KEYS.mine,
    queryFn: () => podcastService.getMyPodcasts(),
    enabled: canUsePrivateApi,
    staleTime: 1000 * 60 * 5,
  });
}

interface ToggleSubscriptionVariables {
  podcastId: string;
  next: boolean;
  podcast?: Podcast;
}

interface ToggleSubscriptionContext {
  previous: PodcastSubscriptions | undefined;
  previousMembership: LibraryMembership | undefined;
}

const EMPTY_SUBSCRIPTIONS: PodcastSubscriptions = { subscriptions: [], total: 0, oxyUserId: '' };

/**
 * Subscribe / unsubscribe with an optimistic patch of BOTH caches the answer
 * lives in, so the Subscribe button and every library surface flip instantly and
 * reconcile with the server on settle.
 *
 * Two caches because they hold two things, not because the state is mirrored:
 * `['library']` is the id set every membership control reads (see
 * {@link useIsSubscribed}) and `['podcasts','subscriptions']` is the page of
 * hydrated shows the library lists render. Patching only the second one is what
 * left the button unable to answer; patching only the first would flip the
 * button and leave the list stale. Both are invalidated on settle, so the server
 * is what they converge on.
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
      const snapshot = (): ToggleSubscriptionContext => ({
        previous: queryClient.getQueryData<PodcastSubscriptions>(PODCAST_QUERY_KEYS.subscriptions),
        previousMembership: queryClient.getQueryData<LibraryMembership>(LIBRARY_QUERY_KEY),
      });

      if (!canUsePrivateApi) {
        return snapshot();
      }
      await Promise.all([
        queryClient.cancelQueries({ queryKey: PODCAST_QUERY_KEYS.subscriptions }),
        queryClient.cancelQueries({ queryKey: LIBRARY_QUERY_KEY }),
      ]);
      const context = snapshot();
      queryClient.setQueryData<LibraryMembership>(LIBRARY_QUERY_KEY, (current) =>
        current ? withMembership(current, 'subscribedPodcasts', podcastId, next) : current,
      );
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
      return context;
    },
    onError: (error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(PODCAST_QUERY_KEYS.subscriptions, context.previous);
      }
      if (context?.previousMembership !== undefined) {
        queryClient.setQueryData(LIBRARY_QUERY_KEY, context.previousMembership);
      }
      toast.error(error.message || 'Could not update your subscriptions');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: PODCAST_QUERY_KEYS.subscriptions });
      queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY });
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
