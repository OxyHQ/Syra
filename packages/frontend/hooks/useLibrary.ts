import { useCallback, useMemo } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { libraryService, type LibraryMembership } from '@/services/libraryService';
import { toast } from '@/lib/sonner';

/**
 * Shared React Query library layer — the single source of truth for the
 * filled/outline state of every like / save / follow control in the app.
 *
 * The membership snapshot (`['library']`) is fetched once and shared by every
 * screen. Mutations update that cache optimistically so a like in the player
 * bar flips the heart in the track row, on the album page, and in the Liked
 * Songs list instantly — Spotify behavior — then reconcile with the server on
 * settle.
 */

export const LIBRARY_QUERY_KEY = ['library'] as const;
export const LIBRARY_TRACKS_QUERY_KEY = ['library', 'tracks'] as const;

/** Which membership collection a mutation targets. */
type MembershipField = keyof LibraryMembership;

const EMPTY_MEMBERSHIP: LibraryMembership = {
  likedTracks: [],
  savedAlbums: [],
  followedArtists: [],
  savedPlaylists: [],
};

/** Add/remove an id within one membership array, returning a new object. */
function withMembership(
  membership: LibraryMembership,
  field: MembershipField,
  id: string,
  next: boolean,
): LibraryMembership {
  const current = membership[field];
  const has = current.includes(id);
  if (next === has) {
    return membership;
  }
  return {
    ...membership,
    [field]: next ? [...current, id] : current.filter((value) => value !== id),
  };
}

/**
 * Membership query + derived O(1) lookups.
 *
 * Lookups are backed by `Set`s memoized off the cached arrays, so checking
 * whether a given track/album/artist/playlist is in the library is constant
 * time regardless of library size. State is derived from the query — no
 * `useEffect`, no mirrored local state.
 */
export function useLibrary() {
  const { canUsePrivateApi } = useOxy();

  const query = useQuery<LibraryMembership>({
    queryKey: LIBRARY_QUERY_KEY,
    queryFn: () => libraryService.getLibrary(),
    enabled: canUsePrivateApi,
    // Membership changes only via this app's own mutations, so a longer stale
    // window is safe and avoids refetch churn; mutations keep it fresh.
    staleTime: 1000 * 60 * 5,
  });

  const membership = query.data ?? EMPTY_MEMBERSHIP;

  const likedTrackIds = useMemo(() => new Set(membership.likedTracks), [membership.likedTracks]);
  const savedAlbumIds = useMemo(() => new Set(membership.savedAlbums), [membership.savedAlbums]);
  const followedArtistIds = useMemo(() => new Set(membership.followedArtists), [membership.followedArtists]);
  const savedPlaylistIds = useMemo(() => new Set(membership.savedPlaylists), [membership.savedPlaylists]);

  const isTrackLiked = useCallback((id: string) => likedTrackIds.has(id), [likedTrackIds]);
  const isAlbumSaved = useCallback((id: string) => savedAlbumIds.has(id), [savedAlbumIds]);
  const isArtistFollowed = useCallback((id: string) => followedArtistIds.has(id), [followedArtistIds]);
  const isPlaylistSaved = useCallback((id: string) => savedPlaylistIds.has(id), [savedPlaylistIds]);

  return {
    membership,
    isLoading: query.isLoading,
    isError: query.isError,
    isTrackLiked,
    isAlbumSaved,
    isArtistFollowed,
    isPlaylistSaved,
  };
}

/** Context carried from `onMutate` to `onError` for rollback. */
interface ToggleContext {
  previous: LibraryMembership | undefined;
}

interface ToggleVariables {
  id: string;
  next: boolean;
}

/**
 * Builds an optimistic toggle mutation for one membership collection.
 *
 * `mutationFn` switches between the `on`/`off` service calls based on the
 * requested next state. On mutate we snapshot and optimistically patch the
 * `['library']` cache; on error we roll back to the snapshot; on settle we
 * invalidate so the server's truth wins.
 */
function useToggleMembership(
  field: MembershipField,
  on: (id: string) => Promise<{ success: boolean }>,
  off: (id: string) => Promise<{ success: boolean }>,
  options?: { invalidateTracks?: boolean; invalidatePlaylists?: boolean },
): UseMutationResult<{ success: boolean }, Error, ToggleVariables, ToggleContext> {
  const queryClient = useQueryClient();
  const { canUsePrivateApi, showBottomSheet } = useOxy();
  const invalidateTracks = options?.invalidateTracks ?? false;
  const invalidatePlaylists = options?.invalidatePlaylists ?? false;

  return useMutation<{ success: boolean }, Error, ToggleVariables, ToggleContext>({
    mutationFn: ({ id, next }) => {
      if (!canUsePrivateApi) {
        showBottomSheet?.('OxyAuth');
        throw new Error('Sign in to save music to your library');
      }
      return next ? on(id) : off(id);
    },
    onMutate: async ({ id, next }) => {
      if (!canUsePrivateApi) {
        return { previous: queryClient.getQueryData<LibraryMembership>(LIBRARY_QUERY_KEY) };
      }
      await queryClient.cancelQueries({ queryKey: LIBRARY_QUERY_KEY });
      const previous = queryClient.getQueryData<LibraryMembership>(LIBRARY_QUERY_KEY);
      queryClient.setQueryData<LibraryMembership>(LIBRARY_QUERY_KEY, (current) =>
        withMembership(current ?? EMPTY_MEMBERSHIP, field, id, next),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(LIBRARY_QUERY_KEY, context.previous);
      }
      toast.error(_error.message || 'Could not update your library');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY });
      if (invalidateTracks) {
        queryClient.invalidateQueries({ queryKey: LIBRARY_TRACKS_QUERY_KEY });
      }
      if (invalidatePlaylists) {
        queryClient.invalidateQueries({ queryKey: ['library', 'playlists'] });
      }
    },
  });
}

export function useToggleLikeTrack() {
  return useToggleMembership('likedTracks', libraryService.likeTrack, libraryService.unlikeTrack, {
    invalidateTracks: true,
  });
}

export function useToggleSaveAlbum() {
  return useToggleMembership('savedAlbums', libraryService.saveAlbum, libraryService.unsaveAlbum);
}

export function useToggleFollowArtist() {
  return useToggleMembership('followedArtists', libraryService.followArtist, libraryService.unfollowArtist);
}

export function useToggleSavePlaylist() {
  return useToggleMembership('savedPlaylists', libraryService.savePlaylist, libraryService.unsavePlaylist, {
    invalidatePlaylists: true,
  });
}

/**
 * Imperatively prime the library cache from another query result.
 *
 * Used when a screen already holds an authoritative membership snapshot
 * (none today), kept exported for symmetry with `invalidateLibrary`.
 */
export function invalidateLibrary(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY });
}
