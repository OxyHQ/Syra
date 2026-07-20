import { useCallback, useMemo } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Album, Artist, Playlist } from '@syra/shared-types';
import { musicService } from '@/services/musicService';
import { useAuthGate, type CatalogIdentity } from '@/hooks/useAuthGate';
import { useLibrary, LIBRARY_QUERY_KEY } from '@/hooks/useLibrary';

/**
 * Hydrated view of the user's library for the Library screen + sidebar.
 *
 * Builds on the shared `['library']` membership cache ({@link useLibrary}):
 * the saved-album / followed-artist ID lists drive per-entity object queries,
 * owned playlists come from their own query, and the liked-track count is
 * derived directly from membership so optimistic likes update it immediately.
 * Because everything is keyed in React Query, an optimistic like/save/follow
 * from anywhere invalidates `['library']`, which re-derives these collections
 * and keeps the counts fresh — no `useEffect`, no mirrored state.
 *
 * The number of hydrated entities is capped so a large library never fans out
 * into an unbounded number of detail requests.
 */
const HYDRATE_LIMIT = 50;

/**
 * Cache keys for individual catalog entities.
 *
 * These are shared: the hydration queries below and the detail screens
 * (`app/album/[id].tsx`, `app/playlist/[id].tsx`, `app/p/[id].tsx`) must
 * produce the SAME key for the same entity, so an album hydrated for the
 * sidebar warms its detail screen instead of occupying a second cache entry.
 *
 * Every key carries the `guest` / `auth` identity suffix required by
 * `AGENTS.md` — catalog responses vary by identity and playback policy, so a
 * guest cold-boot response must never populate the authenticated cache.
 */
export const CATALOG_QUERY_KEYS = {
  album: (id: string, identity: CatalogIdentity) => ['album', id, identity] as const,
  albumTracks: (id: string, identity: CatalogIdentity) => ['album', id, 'tracks', identity] as const,
  playlist: (id: string, identity: CatalogIdentity) => ['playlist', id, identity] as const,
  playlistTracks: (id: string, identity: CatalogIdentity) => ['playlist', id, 'tracks', identity] as const,
  artist: (id: string, identity: CatalogIdentity) => ['artist', id, identity] as const,
  entity: (id: string, identity: CatalogIdentity) => ['entity', id, identity] as const,
};

export interface LibraryCollections {
  playlists: Playlist[];
  savedAlbums: Album[];
  followedArtists: Artist[];
  likedTracksCount: number;
  loading: boolean;
  error: string | null;
  /**
   * Re-arms the auth gate and refetches every query backing these collections
   * (membership, owned playlists, and each hydrated album/artist/playlist).
   * Settles once the refetches do, so an `EmptyState` `onRetry` can await it.
   */
  retry: () => Promise<void>;
}

export function useLibraryCollections(): LibraryCollections {
  const {
    canUsePrivateApi,
    catalogIdentity,
    isResolving,
    isTimedOut,
    retry: retryAuthGate,
  } = useAuthGate();
  const queryClient = useQueryClient();
  const { membership, isLoading: membershipLoading, isError: membershipError } = useLibrary();

  const playlistsQuery = useQuery({
    queryKey: ['library', 'playlists'],
    queryFn: () => musicService.getUserPlaylists(),
    enabled: canUsePrivateApi,
  });

  const albumIds = useMemo(
    () => membership.savedAlbums.slice(0, HYDRATE_LIMIT),
    [membership.savedAlbums],
  );
  const artistIds = useMemo(
    () => membership.followedArtists.slice(0, HYDRATE_LIMIT),
    [membership.followedArtists],
  );
  const playlistIds = useMemo(
    () => membership.savedPlaylists.slice(0, HYDRATE_LIMIT),
    [membership.savedPlaylists],
  );

  const albumQueries = useQueries({
    queries: albumIds.map((albumId) => ({
      queryKey: CATALOG_QUERY_KEYS.album(albumId, catalogIdentity),
      queryFn: () => musicService.getAlbumById(albumId),
      enabled: canUsePrivateApi,
    })),
  });

  const artistQueries = useQueries({
    queries: artistIds.map((artistId) => ({
      queryKey: CATALOG_QUERY_KEYS.artist(artistId, catalogIdentity),
      queryFn: () => musicService.getArtistById(artistId),
      enabled: canUsePrivateApi,
    })),
  });

  const savedPlaylistQueries = useQueries({
    queries: playlistIds.map((playlistId) => ({
      queryKey: CATALOG_QUERY_KEYS.playlist(playlistId, catalogIdentity),
      queryFn: () => musicService.getPlaylistById(playlistId),
      enabled: canUsePrivateApi,
    })),
  });

  const savedAlbums = useMemo(
    () => albumQueries.map((q) => q.data).filter((album): album is Album => album != null),
    [albumQueries],
  );
  const followedArtists = useMemo(
    () => artistQueries.map((q) => q.data).filter((artist): artist is Artist => artist != null),
    [artistQueries],
  );
  const playlists = useMemo(() => {
    const owned = playlistsQuery.data?.playlists ?? [];
    const saved = savedPlaylistQueries
      .map((q) => q.data)
      .filter((playlist): playlist is Playlist => playlist != null);
    const byId = new Map<string, Playlist>();
    [...owned, ...saved].forEach((playlist) => byId.set(playlist.id, playlist));
    return Array.from(byId.values());
  }, [playlistsQuery.data, savedPlaylistQueries]);

  const queriesLoading =
    membershipLoading ||
    playlistsQuery.isLoading ||
    albumQueries.some((q) => q.isLoading) ||
    artistQueries.some((q) => q.isLoading) ||
    savedPlaylistQueries.some((q) => q.isLoading);

  const queriesError =
    membershipError ||
    playlistsQuery.isError ||
    albumQueries.some((q) => q.isError) ||
    artistQueries.some((q) => q.isError) ||
    savedPlaylistQueries.some((q) => q.isError)
      ? 'Failed to load library data'
      : null;

  // Refetches EVERY query behind these collections, not just membership: the
  // `['library']` root covers membership + owned playlists, then each hydrated
  // entity goes by its exact key. Exact keys rather than the `['album']` /
  // `['artist']` / `['playlist']` roots because on web the sidebar stays mounted
  // alongside an open detail screen, and a root invalidation would drag that
  // screen's queries along too.
  //
  // Re-arming the auth gate first is load-bearing: when the failure IS the auth
  // timeout every query here is disabled, so a query-only refetch would be a
  // dead button. Returns a promise that settles once the refetches do, so
  // `EmptyState` can drive its own spinner off it.
  const retry = useCallback(async () => {
    retryAuthGate();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY }),
      ...albumIds.map((albumId) =>
        queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEYS.album(albumId, catalogIdentity) }),
      ),
      ...artistIds.map((artistId) =>
        queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEYS.artist(artistId, catalogIdentity) }),
      ),
      ...playlistIds.map((playlistId) =>
        queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEYS.playlist(playlistId, catalogIdentity) }),
      ),
    ]);
  }, [queryClient, retryAuthGate, albumIds, artistIds, playlistIds, catalogIdentity]);

  return {
    playlists,
    savedAlbums,
    followedArtists,
    likedTracksCount: membership.likedTracks.length,
    // An unresolved session has no answer yet, so it reports as loading. The
    // previous `canUsePrivateApi ? loading : false` reported "resolved and
    // empty" to an authenticated user whose token never arrived, rendering
    // "Your library is empty" over a library that exists.
    loading: isResolving || (canUsePrivateApi && queriesLoading),
    error: isTimedOut ? 'We could not verify your session' : queriesError,
    retry,
  };
}
