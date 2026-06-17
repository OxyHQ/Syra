import { useOxy } from '@oxyhq/services';
import { QueryClient, useQuery } from '@tanstack/react-query';
import { browseService } from '@/services/browseService';
import { libraryService } from '@/services/libraryService';
import { musicService } from '@/services/musicService';

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
  queryKey: HOME_QUERY_KEYS.browse,
  queryFn: () => browseService.getHome({
    sectionLimit: HOME_LIMITS.madeForYou,
    tracksLimit: HOME_LIMITS.tracks,
  }),
  staleTime: 1000 * 60 * 10,
} as const;

export function prefetchHomeBrowse(queryClient: QueryClient): void {
  void queryClient.prefetchQuery(HOME_BROWSE_QUERY_OPTIONS);
}

/**
 * Real recently-played tracks for the signed-in user ("Jump back in").
 *
 * Authenticated-only — guests have no play history. The screen hides the
 * section when the list is empty rather than faking it.
 */
export function useRecentlyPlayed() {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: HOME_QUERY_KEYS.recentlyPlayed,
    queryFn: () => libraryService.getRecentlyPlayed(HOME_LIMITS.recentlyPlayed),
    enabled: isAuthenticated,
    // Plays land here continuously, so keep it fresher than the global default.
    staleTime: 1000 * 30,
  });
}

/** Real "Made for you" recommendations (popular albums + public playlists). */
export function useMadeForYou() {
  return useQuery({
    ...HOME_BROWSE_QUERY_OPTIONS,
    select: (data) => data.madeForYou,
  });
}

/** Real popular albums, ranked by catalog popularity. */
export function usePopularAlbums() {
  return useQuery({
    ...HOME_BROWSE_QUERY_OPTIONS,
    select: (data) => data.popularAlbums,
  });
}

/** Real popular artists, ranked by catalog popularity. */
export function usePopularArtists() {
  return useQuery({
    ...HOME_BROWSE_QUERY_OPTIONS,
    select: (data) => data.popularArtists,
  });
}

/** The signed-in user's own playlists (authenticated-only). */
export function useUserPlaylists() {
  const { isAuthenticated } = useOxy();
  return useQuery({
    queryKey: HOME_QUERY_KEYS.userPlaylists,
    queryFn: () => musicService.getUserPlaylists(),
    enabled: isAuthenticated,
  });
}

/** Real popular tracks for the bottom track list. */
export function usePopularTracks() {
  return useQuery({
    ...HOME_BROWSE_QUERY_OPTIONS,
    select: (data) => data.tracks,
  });
}
