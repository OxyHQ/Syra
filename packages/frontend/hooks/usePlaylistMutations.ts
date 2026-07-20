import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import type { Playlist, Track, UpdatePlaylistRequest } from '@syra/shared-types';
import {
  playlistService,
  type AddTracksResult,
  type RemoveTracksResult,
  type ReorderTracksResult,
} from '@/services/playlistService';
import { CATALOG_QUERY_KEYS } from '@/hooks/useLibraryCollections';
import { LIBRARY_QUERY_KEY } from '@/hooks/useLibrary';
import { useAuthGate } from '@/hooks/useAuthGate';
import { toast } from '@/lib/sonner';

/**
 * Playlist edit mutations, following the optimistic pattern established by
 * {@link useToggleLikeTrack}: snapshot in `onMutate`, patch the caches so the
 * UI moves immediately, roll back to the snapshot in `onError`, and invalidate
 * in `onSettled` so the server's truth wins.
 *
 * Three caches are affected by every playlist edit and all three are kept in
 * sync here, so an edit lands in the playlist screen, the library list, and the
 * sidebar at once with no reload:
 *
 * - `CATALOG_QUERY_KEYS.playlist(id, identity)` — the detail object (name,
 *   visibility, `trackCount`), cached as a `Playlist`.
 * - `CATALOG_QUERY_KEYS.playlistTracks(id, identity)` — the ordered track list,
 *   cached as a bare `Track[]` (the screen unwraps the response envelope).
 * - `OWNED_PLAYLISTS_QUERY_KEY` — the user's own playlists, cached as
 *   `{ playlists, total }`, which backs both the library screen and the sidebar.
 *
 * Optimistic writes address one identity (`auth`, since every one of these
 * endpoints requires a session), while invalidation goes through the
 * `['playlist', id]` PREFIX so any `guest`-scoped entry for the same playlist is
 * refetched too rather than left stale behind a differently-keyed cache entry.
 */

/** Owned playlists, as keyed by `useLibraryCollections`. */
const OWNED_PLAYLISTS_QUERY_KEY = ['library', 'playlists'] as const;

interface OwnedPlaylistsData {
  playlists: Playlist[];
  total: number;
}

/** Everything one playlist edit can invalidate. */
function invalidatePlaylistCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  playlistId: string,
): void {
  // Prefix match: covers the detail entry, its `tracks` child, and both
  // identity scopes in one pass.
  queryClient.invalidateQueries({ queryKey: ['playlist', playlistId] });
  queryClient.invalidateQueries({ queryKey: OWNED_PLAYLISTS_QUERY_KEY });
  queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY });
}

/**
 * Shared sign-in guard. These endpoints are all authenticated, so an anonymous
 * caller is prompted rather than sent to the backend for a guaranteed 401.
 */
function useRequireSession(): () => void {
  const { canUsePrivateApi, openAccountDialog } = useOxy();
  return () => {
    if (!canUsePrivateApi) {
      openAccountDialog('signin');
      throw new Error('Sign in to edit your playlists');
    }
  };
}

// ── Update ────────────────────────────────────────────────────────────────────

interface UpdatePlaylistVariables {
  playlistId: string;
  updates: UpdatePlaylistRequest;
}

interface UpdatePlaylistContext {
  previousDetail: Playlist | undefined;
  previousOwned: OwnedPlaylistsData | undefined;
}

/**
 * Rename / re-describe / re-cover / change visibility of a playlist.
 *
 * `coverArt` must be an already-uploaded image id — the backend rejects blob:
 * and http(s): values with a 400.
 */
export function useUpdatePlaylist(): UseMutationResult<
  Playlist,
  Error,
  UpdatePlaylistVariables,
  UpdatePlaylistContext
> {
  const queryClient = useQueryClient();
  const { catalogIdentity } = useAuthGate();
  const requireSession = useRequireSession();

  return useMutation<Playlist, Error, UpdatePlaylistVariables, UpdatePlaylistContext>({
    mutationFn: ({ playlistId, updates }) => {
      requireSession();
      return playlistService.updatePlaylist(playlistId, updates);
    },
    onMutate: async ({ playlistId, updates }) => {
      const detailKey = CATALOG_QUERY_KEYS.playlist(playlistId, catalogIdentity);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: detailKey }),
        queryClient.cancelQueries({ queryKey: OWNED_PLAYLISTS_QUERY_KEY }),
      ]);

      const previousDetail = queryClient.getQueryData<Playlist>(detailKey);
      const previousOwned = queryClient.getQueryData<OwnedPlaylistsData>(OWNED_PLAYLISTS_QUERY_KEY);

      // `coverArt` is deliberately not patched optimistically: the client holds
      // an image id, while the cache holds the resolved URL the service
      // normalizes on read. Showing the raw id would blank the artwork until
      // the refetch lands, so the cover updates on settle instead.
      const patch: Partial<Playlist> = {};
      if (updates.name !== undefined) patch.name = updates.name;
      if (updates.description !== undefined) patch.description = updates.description;
      if (updates.visibility !== undefined) patch.visibility = updates.visibility;

      queryClient.setQueryData<Playlist>(detailKey, (current) =>
        current ? { ...current, ...patch } : current,
      );
      queryClient.setQueryData<OwnedPlaylistsData>(OWNED_PLAYLISTS_QUERY_KEY, (current) =>
        current
          ? {
              ...current,
              playlists: current.playlists.map((playlist) =>
                playlist.id === playlistId ? { ...playlist, ...patch } : playlist,
              ),
            }
          : current,
      );

      return { previousDetail, previousOwned };
    },
    onSuccess: (playlist, { playlistId }) => {
      // The server's formatted playlist is authoritative and already
      // image-normalized, so adopt it wholesale rather than waiting on refetch.
      queryClient.setQueryData<Playlist>(
        CATALOG_QUERY_KEYS.playlist(playlistId, catalogIdentity),
        playlist,
      );
    },
    onError: (error, { playlistId }, context) => {
      if (context?.previousDetail !== undefined) {
        queryClient.setQueryData(
          CATALOG_QUERY_KEYS.playlist(playlistId, catalogIdentity),
          context.previousDetail,
        );
      }
      if (context?.previousOwned !== undefined) {
        queryClient.setQueryData(OWNED_PLAYLISTS_QUERY_KEY, context.previousOwned);
      }
      toast.error(error.message || 'Could not update this playlist');
    },
    onSettled: (_data, _error, { playlistId }) => {
      invalidatePlaylistCaches(queryClient, playlistId);
    },
  });
}

// ── Delete ────────────────────────────────────────────────────────────────────

interface DeletePlaylistVariables {
  playlistId: string;
}

interface DeletePlaylistContext {
  previousOwned: OwnedPlaylistsData | undefined;
}

/**
 * Delete a playlist. Owner only — a collaborator gets a 403, which surfaces as
 * a toast and a rollback of the optimistic removal.
 *
 * Callers on the playlist's own screen should navigate away in `onSuccess`;
 * this hook only owns cache state.
 */
export function useDeletePlaylist(): UseMutationResult<
  void,
  Error,
  DeletePlaylistVariables,
  DeletePlaylistContext
> {
  const queryClient = useQueryClient();
  const requireSession = useRequireSession();

  return useMutation<void, Error, DeletePlaylistVariables, DeletePlaylistContext>({
    mutationFn: ({ playlistId }) => {
      requireSession();
      return playlistService.deletePlaylist(playlistId);
    },
    onMutate: async ({ playlistId }) => {
      await queryClient.cancelQueries({ queryKey: OWNED_PLAYLISTS_QUERY_KEY });
      const previousOwned = queryClient.getQueryData<OwnedPlaylistsData>(OWNED_PLAYLISTS_QUERY_KEY);

      queryClient.setQueryData<OwnedPlaylistsData>(OWNED_PLAYLISTS_QUERY_KEY, (current) => {
        if (!current) {
          return current;
        }
        const playlists = current.playlists.filter((playlist) => playlist.id !== playlistId);
        return {
          playlists,
          total: Math.max(0, current.total - (current.playlists.length - playlists.length)),
        };
      });

      return { previousOwned };
    },
    onSuccess: (_result, { playlistId }) => {
      // The entity is gone; drop its cache entries outright so a stale detail
      // page can't be served from cache before the invalidation refetch 404s.
      queryClient.removeQueries({ queryKey: ['playlist', playlistId] });
    },
    onError: (error, _variables, context) => {
      if (context?.previousOwned !== undefined) {
        queryClient.setQueryData(OWNED_PLAYLISTS_QUERY_KEY, context.previousOwned);
      }
      toast.error(error.message || 'Could not delete this playlist');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: OWNED_PLAYLISTS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY });
    },
  });
}

// ── Add tracks ────────────────────────────────────────────────────────────────

interface AddTracksVariables {
  playlistId: string;
  trackIds: string[];
  /**
   * Full track objects for the optimistic insert. The caller almost always has
   * them (a track row, a queue entry, a search result); without them the list
   * simply waits for the refetch instead of showing placeholder rows.
   */
  tracks?: Track[];
  /** Insert position. Omitted appends to the end. */
  position?: number;
}

interface AddTracksContext {
  previousTracks: Track[] | undefined;
  previousDetail: Playlist | undefined;
}

/**
 * Add tracks to a playlist.
 *
 * Note the backend answers 400 when EVERY requested track is already present,
 * so adding a single duplicate throws — the toast ("All tracks are already in
 * the playlist") is the correct user-facing outcome, and the optimistic insert
 * rolls back.
 */
export function useAddTracksToPlaylist(): UseMutationResult<
  AddTracksResult,
  Error,
  AddTracksVariables,
  AddTracksContext
> {
  const queryClient = useQueryClient();
  const { catalogIdentity } = useAuthGate();
  const requireSession = useRequireSession();

  return useMutation<AddTracksResult, Error, AddTracksVariables, AddTracksContext>({
    mutationFn: ({ playlistId, trackIds, position }) => {
      requireSession();
      return playlistService.addTracks(playlistId, trackIds, position);
    },
    onMutate: async ({ playlistId, tracks, position }) => {
      const tracksKey = CATALOG_QUERY_KEYS.playlistTracks(playlistId, catalogIdentity);
      const detailKey = CATALOG_QUERY_KEYS.playlist(playlistId, catalogIdentity);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: tracksKey }),
        queryClient.cancelQueries({ queryKey: detailKey }),
      ]);

      const previousTracks = queryClient.getQueryData<Track[]>(tracksKey);
      const previousDetail = queryClient.getQueryData<Playlist>(detailKey);

      if (tracks && tracks.length > 0) {
        // Mirror the backend's de-duplication so the optimistic count matches
        // what the server will actually insert.
        const existingIds = new Set((previousTracks ?? []).map((track) => track.id));
        const inserted = tracks.filter((track) => !existingIds.has(track.id));

        if (inserted.length > 0) {
          queryClient.setQueryData<Track[]>(tracksKey, (current) => {
            if (!current) {
              return current;
            }
            if (position === undefined || position >= current.length) {
              return [...current, ...inserted];
            }
            const at = Math.max(0, position);
            return [...current.slice(0, at), ...inserted, ...current.slice(at)];
          });
          queryClient.setQueryData<Playlist>(detailKey, (current) =>
            current
              ? { ...current, trackCount: (current.trackCount ?? 0) + inserted.length }
              : current,
          );
        }
      }

      return { previousTracks, previousDetail };
    },
    onError: (error, { playlistId }, context) => {
      const tracksKey = CATALOG_QUERY_KEYS.playlistTracks(playlistId, catalogIdentity);
      const detailKey = CATALOG_QUERY_KEYS.playlist(playlistId, catalogIdentity);
      if (context?.previousTracks !== undefined) {
        queryClient.setQueryData(tracksKey, context.previousTracks);
      }
      if (context?.previousDetail !== undefined) {
        queryClient.setQueryData(detailKey, context.previousDetail);
      }
      toast.error(error.message || 'Could not add to this playlist');
    },
    onSettled: (_data, _error, { playlistId }) => {
      invalidatePlaylistCaches(queryClient, playlistId);
    },
  });
}

// ── Remove tracks ─────────────────────────────────────────────────────────────

interface RemoveTracksVariables {
  playlistId: string;
  trackIds: string[];
}

interface RemoveTracksContext {
  previousTracks: Track[] | undefined;
  previousDetail: Playlist | undefined;
}

/**
 * Remove tracks from a playlist.
 *
 * Fully optimistic: the row disappears on tap and comes back if the request
 * fails. Ids not actually in the playlist are no-ops server-side, so this never
 * errors merely because the list was already out of date.
 */
export function useRemoveTracksFromPlaylist(): UseMutationResult<
  RemoveTracksResult,
  Error,
  RemoveTracksVariables,
  RemoveTracksContext
> {
  const queryClient = useQueryClient();
  const { catalogIdentity } = useAuthGate();
  const requireSession = useRequireSession();

  return useMutation<RemoveTracksResult, Error, RemoveTracksVariables, RemoveTracksContext>({
    mutationFn: ({ playlistId, trackIds }) => {
      requireSession();
      return playlistService.removeTracks(playlistId, trackIds);
    },
    onMutate: async ({ playlistId, trackIds }) => {
      const tracksKey = CATALOG_QUERY_KEYS.playlistTracks(playlistId, catalogIdentity);
      const detailKey = CATALOG_QUERY_KEYS.playlist(playlistId, catalogIdentity);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: tracksKey }),
        queryClient.cancelQueries({ queryKey: detailKey }),
      ]);

      const previousTracks = queryClient.getQueryData<Track[]>(tracksKey);
      const previousDetail = queryClient.getQueryData<Playlist>(detailKey);

      const removing = new Set(trackIds);
      // Count against the cache rather than `trackIds.length` so `trackCount`
      // only drops by rows that were actually there.
      const removedCount = (previousTracks ?? []).filter((track) => removing.has(track.id)).length;

      queryClient.setQueryData<Track[]>(tracksKey, (current) =>
        current ? current.filter((track) => !removing.has(track.id)) : current,
      );
      if (removedCount > 0) {
        queryClient.setQueryData<Playlist>(detailKey, (current) =>
          current
            ? { ...current, trackCount: Math.max(0, (current.trackCount ?? 0) - removedCount) }
            : current,
        );
      }

      return { previousTracks, previousDetail };
    },
    onError: (error, { playlistId }, context) => {
      if (context?.previousTracks !== undefined) {
        queryClient.setQueryData(
          CATALOG_QUERY_KEYS.playlistTracks(playlistId, catalogIdentity),
          context.previousTracks,
        );
      }
      if (context?.previousDetail !== undefined) {
        queryClient.setQueryData(
          CATALOG_QUERY_KEYS.playlist(playlistId, catalogIdentity),
          context.previousDetail,
        );
      }
      toast.error(error.message || 'Could not remove from this playlist');
    },
    onSettled: (_data, _error, { playlistId }) => {
      invalidatePlaylistCaches(queryClient, playlistId);
    },
  });
}

// ── Reorder tracks ────────────────────────────────────────────────────────────

interface ReorderTracksVariables {
  playlistId: string;
  /**
   * The COMPLETE new order. The backend 400s if any id is missing from the
   * playlist, so a moved subset is not a valid payload.
   */
  trackIds: string[];
}

interface ReorderTracksContext {
  previousTracks: Track[] | undefined;
}

/**
 * Reorder a playlist's tracks.
 *
 * This is the one mutation where optimism is doing real work: a drag-and-drop
 * that snapped back to the old order while a request flew would be unusable.
 */
export function useReorderPlaylistTracks(): UseMutationResult<
  ReorderTracksResult,
  Error,
  ReorderTracksVariables,
  ReorderTracksContext
> {
  const queryClient = useQueryClient();
  const { catalogIdentity } = useAuthGate();
  const requireSession = useRequireSession();

  return useMutation<ReorderTracksResult, Error, ReorderTracksVariables, ReorderTracksContext>({
    mutationFn: ({ playlistId, trackIds }) => {
      requireSession();
      return playlistService.reorderTracks(playlistId, trackIds);
    },
    onMutate: async ({ playlistId, trackIds }) => {
      const tracksKey = CATALOG_QUERY_KEYS.playlistTracks(playlistId, catalogIdentity);
      await queryClient.cancelQueries({ queryKey: tracksKey });
      const previousTracks = queryClient.getQueryData<Track[]>(tracksKey);

      queryClient.setQueryData<Track[]>(tracksKey, (current) => {
        if (!current) {
          return current;
        }
        const byId = new Map(current.map((track) => [track.id, track]));
        const reordered = trackIds
          .map((trackId) => byId.get(trackId))
          .filter((track): track is Track => track !== undefined);
        // An id the cache doesn't know about means the caller and the cache
        // disagree; keep the cache untouched and let the server's answer settle
        // it rather than silently dropping rows.
        return reordered.length === current.length ? reordered : current;
      });

      return { previousTracks };
    },
    onError: (error, { playlistId }, context) => {
      if (context?.previousTracks !== undefined) {
        queryClient.setQueryData(
          CATALOG_QUERY_KEYS.playlistTracks(playlistId, catalogIdentity),
          context.previousTracks,
        );
      }
      toast.error(error.message || 'Could not reorder this playlist');
    },
    onSettled: (_data, _error, { playlistId }) => {
      queryClient.invalidateQueries({ queryKey: ['playlist', playlistId] });
    },
  });
}
