import { QueryClient, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Podcast } from '@syra/shared-types';
import { browseService } from '@/services/browseService';
import { libraryService } from '@/services/libraryService';
import { musicService } from '@/services/musicService';
import { useAuthGate, type AuthGate, type CatalogIdentity } from '@/hooks/useAuthGate';
import { usePodcasts } from '@/hooks/usePodcasts';
import type {
  HomeBrowseResponse,
  MadeForYouResponse,
  PopularAlbumsResponse,
  PopularArtistsResponse,
  PopularTracksResponse,
} from '@/services/browseService';

/**
 * React Query layer for the home screen.
 *
 * Every section is backed by a REAL backend endpoint — no slicing or
 * relabeling of a single generic list. Each section owns its own query so it
 * loads, caches, and errors independently; the screen derives its UI entirely
 * from these queries (no `useEffect`, no mirrored `useState`).
 *
 * Authenticated-only sections (recently-played, the user's playlists) are
 * gated with `enabled` so guests never fire those requests — and every hook
 * here reports a {@link HomeSectionStatus} so a gated-shut query still resolves
 * to something the visitor can act on.
 */

/** How many items each home section requests. */
const HOME_LIMITS = {
  recentlyPlayed: 20,
  madeForYou: 8,
  popularAlbums: 8,
  popularArtists: 8,
  userPlaylists: 8,
  podcasts: 12,
  tracks: 20,
} as const;

/**
 * What a home section should render right now.
 *
 * React Query reports `isPending: true` for a query disabled via `enabled`, so
 * a section that keys its skeleton off `isPending` sits on that skeleton for
 * the whole session — a signed-out visitor would never see "Jump back in"
 * resolve. Sections branch on this status instead: `loading` only while a
 * request is genuinely in flight (or the session is resolving inside its time
 * bound), `signed-out` when the section needs an account the visitor does not
 * have, `error` when the request or the session gate failed, and `ready` once
 * there is data to render (which may legitimately be empty).
 */
export type HomeSectionStatus = 'loading' | 'signed-out' | 'error' | 'ready';

export interface HomeSection<TData> {
  status: HomeSectionStatus;
  data: TData | undefined;
  /**
   * `error` because the session gate timed out rather than because this
   * request failed. It is the same failure for every gated section, so the
   * screen reports it once instead of once per rail.
   */
  blockedBySession: boolean;
  /** Re-runs the request (or re-arms the session bound); drives retry buttons. */
  retry: () => Promise<void>;
}

interface HomeSectionGating {
  /** Needs a signed-in account — guests get a sign-in call to action. */
  requiresAccount: boolean;
  /** The query is held shut until the Oxy session reaches a terminal identity. */
  waitsForSession: boolean;
}

function toHomeSection<TData>(
  query: UseQueryResult<TData, Error>,
  gate: AuthGate,
  gating: HomeSectionGating,
): HomeSection<TData> {
  const status: HomeSectionStatus = gate.isTimedOut
    ? 'error'
    : gate.isResolving
      ? 'loading'
      : gating.requiresAccount && !gate.canUsePrivateApi
        ? 'signed-out'
        : query.isLoading
          ? 'loading'
          : query.isError
            ? 'error'
            : 'ready';

  return {
    status,
    data: query.data,
    blockedBySession: gate.isTimedOut,
    // A gate that never resolved leaves the query disabled, so retrying means
    // giving the session another window — not forcing an identity-sensitive
    // read to run before we know who is asking.
    retry: async () => {
      if (!gate.isResolved) {
        gate.retry();
        return;
      }
      await query.refetch();
    },
  };
}

export const HOME_QUERY_KEYS = {
  browse: ['home', 'browse'] as const,
  recentlyPlayed: ['home', 'recently-played'] as const,
  madeForYou: ['home', 'made-for-you'] as const,
  popularAlbums: ['home', 'popular-albums'] as const,
  popularArtists: ['home', 'popular-artists'] as const,
  userPlaylists: ['home', 'user-playlists'] as const,
  tracks: ['home', 'tracks'] as const,
};

const HOME_BROWSE_QUERY_OPTIONS = {
  queryKey: [...HOME_QUERY_KEYS.browse, 'guest'] as const,
  queryFn: () => browseService.getHome({
    sectionLimit: HOME_LIMITS.madeForYou,
    tracksLimit: HOME_LIMITS.tracks,
  }),
  staleTime: 1000 * 60 * 10,
} as const;

export function prefetchHomeBrowse(queryClient: QueryClient): void {
  void queryClient.prefetchQuery(HOME_BROWSE_QUERY_OPTIONS);
}

function homeBrowseQueryOptions(identity: CatalogIdentity) {
  return {
    queryKey: [...HOME_QUERY_KEYS.browse, identity] as const,
    queryFn: () => browseService.getHome({
      sectionLimit: HOME_LIMITS.madeForYou,
      tracksLimit: HOME_LIMITS.tracks,
    }),
    staleTime: 1000 * 60 * 10,
  };
}

/**
 * Real recently-played tracks for the signed-in user ("Jump back in").
 *
 * Authenticated-only — guests have no play history, so the section resolves to
 * `signed-out` and the screen offers a sign-in instead of an endless skeleton.
 */
export function useRecentlyPlayed() {
  const gate = useAuthGate();
  const query = useQuery({
    queryKey: HOME_QUERY_KEYS.recentlyPlayed,
    queryFn: () => libraryService.getRecentlyPlayed(HOME_LIMITS.recentlyPlayed),
    enabled: gate.canUsePrivateApi,
    // Plays land here continuously, so keep it fresher than the global default.
    staleTime: 1000 * 30,
  });
  return toHomeSection(query, gate, { requiresAccount: true, waitsForSession: true });
}

/** Real "Made for you" recommendations (popular albums + public playlists). */
export function useMadeForYou() {
  const gate = useAuthGate();
  const query = useQuery({
    ...homeBrowseQueryOptions(gate.catalogIdentity),
    enabled: gate.isResolved,
    select: (data: HomeBrowseResponse): MadeForYouResponse => data.madeForYou,
  });
  return toHomeSection(query, gate, { requiresAccount: false, waitsForSession: true });
}

/** Real popular albums, ranked by catalog popularity. */
export function usePopularAlbums() {
  const gate = useAuthGate();
  const query = useQuery({
    ...homeBrowseQueryOptions(gate.catalogIdentity),
    enabled: gate.isResolved,
    select: (data: HomeBrowseResponse): PopularAlbumsResponse => data.popularAlbums,
  });
  return toHomeSection(query, gate, { requiresAccount: false, waitsForSession: true });
}

/** Real popular artists, ranked by catalog popularity. */
export function usePopularArtists() {
  const gate = useAuthGate();
  const query = useQuery({
    ...homeBrowseQueryOptions(gate.catalogIdentity),
    enabled: gate.isResolved,
    select: (data: HomeBrowseResponse): PopularArtistsResponse => data.popularArtists,
  });
  return toHomeSection(query, gate, { requiresAccount: false, waitsForSession: true });
}

/** The signed-in user's own playlists (authenticated-only). */
export function useUserPlaylists() {
  const gate = useAuthGate();
  const query = useQuery({
    queryKey: HOME_QUERY_KEYS.userPlaylists,
    queryFn: () => musicService.getUserPlaylists(),
    enabled: gate.canUsePrivateApi,
  });
  return toHomeSection(query, gate, { requiresAccount: true, waitsForSession: true });
}

/** Real popular tracks for the bottom track list. */
export function usePopularTracks() {
  const gate = useAuthGate();
  const query = useQuery({
    ...homeBrowseQueryOptions(gate.catalogIdentity),
    enabled: gate.isResolved,
    select: (data: HomeBrowseResponse): PopularTracksResponse => data.tracks,
  });
  return toHomeSection(query, gate, { requiresAccount: false, waitsForSession: true });
}

/**
 * Popular podcast shows for the home rail. The podcast catalog is public and
 * identity-independent, so this section has no session gate at all — its status
 * is exactly the request's, for guests and signed-in listeners alike.
 */
export function useHomePodcasts(): HomeSection<Podcast[]> {
  const query = usePodcasts({ sort: 'popular', limit: HOME_LIMITS.podcasts });
  return {
    status: query.isLoading ? 'loading' : query.isError ? 'error' : 'ready',
    data: query.data,
    blockedBySession: false,
    retry: async () => {
      await query.refetch();
    },
  };
}
