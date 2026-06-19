import { useOxy } from '@oxyhq/services';
import { QueryClient, useQuery } from '@tanstack/react-query';
import { browseService } from '@/services/browseService';
import { libraryService } from '@/services/libraryService';
import { musicService } from '@/services/musicService';
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
 * gated with `enabled` so guests never fire those requests.
 */

/** How many items each home section requests. */
const HOME_LIMITS = {
  recentlyPlayed: 20,
  madeForYou: 8,
  popularAlbums: 8,
  popularArtists: 8,
  userPlaylists: 8,
  tracks: 20,
} as const;

type CatalogIdentity = 'auth' | 'guest';

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

function resolveCatalogIdentity(canUsePrivateApi: boolean): CatalogIdentity {
  return canUsePrivateApi ? 'auth' : 'guest';
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
 * Authenticated-only — guests have no play history. The screen hides the
 * section when the list is empty rather than faking it.
 */
export function useRecentlyPlayed() {
  const { canUsePrivateApi } = useOxy();
  return useQuery({
    queryKey: HOME_QUERY_KEYS.recentlyPlayed,
    queryFn: () => libraryService.getRecentlyPlayed(HOME_LIMITS.recentlyPlayed),
    enabled: canUsePrivateApi,
    // Plays land here continuously, so keep it fresher than the global default.
    staleTime: 1000 * 30,
  });
}

/** Real "Made for you" recommendations (popular albums + public playlists). */
export function useMadeForYou() {
  const { canUsePrivateApi, isPrivateApiPending } = useOxy();
  return useQuery({
    ...homeBrowseQueryOptions(resolveCatalogIdentity(canUsePrivateApi)),
    enabled: !isPrivateApiPending,
    select: (data: HomeBrowseResponse): MadeForYouResponse => data.madeForYou,
  });
}

/** Real popular albums, ranked by catalog popularity. */
export function usePopularAlbums() {
  const { canUsePrivateApi, isPrivateApiPending } = useOxy();
  return useQuery({
    ...homeBrowseQueryOptions(resolveCatalogIdentity(canUsePrivateApi)),
    enabled: !isPrivateApiPending,
    select: (data: HomeBrowseResponse): PopularAlbumsResponse => data.popularAlbums,
  });
}

/** Real popular artists, ranked by catalog popularity. */
export function usePopularArtists() {
  const { canUsePrivateApi, isPrivateApiPending } = useOxy();
  return useQuery({
    ...homeBrowseQueryOptions(resolveCatalogIdentity(canUsePrivateApi)),
    enabled: !isPrivateApiPending,
    select: (data: HomeBrowseResponse): PopularArtistsResponse => data.popularArtists,
  });
}

/** The signed-in user's own playlists (authenticated-only). */
export function useUserPlaylists() {
  const { canUsePrivateApi } = useOxy();
  return useQuery({
    queryKey: HOME_QUERY_KEYS.userPlaylists,
    queryFn: () => musicService.getUserPlaylists(),
    enabled: canUsePrivateApi,
  });
}

/** Real popular tracks for the bottom track list. */
export function usePopularTracks() {
  const { canUsePrivateApi, isPrivateApiPending } = useOxy();
  return useQuery({
    ...homeBrowseQueryOptions(resolveCatalogIdentity(canUsePrivateApi)),
    enabled: !isPrivateApiPending,
    select: (data: HomeBrowseResponse): PopularTracksResponse => data.tracks,
  });
}
