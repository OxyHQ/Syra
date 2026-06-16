import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { Album, Artist, Playlist } from '@syra/shared-types';
import { musicService } from '@/services/musicService';
import { libraryService } from '@/services/libraryService';
import { useLibrary } from '@/hooks/useLibrary';

/**
 * Hydrated view of the user's library for the Library screen + sidebar.
 *
 * Builds on the shared `['library']` membership cache ({@link useLibrary}):
 * the saved-album / followed-artist ID lists drive per-entity object queries,
 * and owned playlists + the liked-track count come from their own queries.
 * Because everything is keyed in React Query, an optimistic like/save/follow
 * from anywhere invalidates `['library']`, which re-derives these collections
 * and keeps the counts fresh — no `useEffect`, no mirrored state.
 *
 * The number of hydrated entities is capped so a large library never fans out
 * into an unbounded number of detail requests.
 */
const HYDRATE_LIMIT = 50;

export interface LibraryCollections {
  playlists: Playlist[];
  savedAlbums: Album[];
  followedArtists: Artist[];
  likedTracksCount: number;
  loading: boolean;
  error: string | null;
}

export function useLibraryCollections(): LibraryCollections {
  const { isAuthenticated } = useOxy();
  const { membership, isLoading: membershipLoading, isError: membershipError } = useLibrary();

  const playlistsQuery = useQuery({
    queryKey: ['library', 'playlists'],
    queryFn: () => musicService.getUserPlaylists(),
    enabled: isAuthenticated,
  });

  const likedTracksQuery = useQuery({
    queryKey: ['library', 'tracks'],
    queryFn: () => libraryService.getLikedTracks(),
    enabled: isAuthenticated,
  });

  const albumIds = useMemo(
    () => membership.savedAlbums.slice(0, HYDRATE_LIMIT),
    [membership.savedAlbums],
  );
  const artistIds = useMemo(
    () => membership.followedArtists.slice(0, HYDRATE_LIMIT),
    [membership.followedArtists],
  );

  const albumQueries = useQueries({
    queries: albumIds.map((albumId) => ({
      queryKey: ['album', albumId],
      queryFn: () => musicService.getAlbumById(albumId),
      enabled: isAuthenticated,
    })),
  });

  const artistQueries = useQueries({
    queries: artistIds.map((artistId) => ({
      queryKey: ['artist', artistId],
      queryFn: () => musicService.getArtistById(artistId),
      enabled: isAuthenticated,
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

  const loading =
    membershipLoading ||
    playlistsQuery.isLoading ||
    likedTracksQuery.isLoading ||
    albumQueries.some((q) => q.isLoading) ||
    artistQueries.some((q) => q.isLoading);

  const error = membershipError || playlistsQuery.isError ? 'Failed to load library data' : null;

  return {
    playlists: playlistsQuery.data?.playlists ?? [],
    savedAlbums,
    followedArtists,
    likedTracksCount: likedTracksQuery.data?.total ?? 0,
    loading: isAuthenticated ? loading : false,
    error,
  };
}
