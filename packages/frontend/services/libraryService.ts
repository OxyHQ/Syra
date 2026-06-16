import { api } from '@/utils/api';
import { Track } from '@syra/shared-types';

/**
 * Membership snapshot for the authenticated user's library.
 *
 * This is the single source of truth that drives the filled/outline state of
 * every like / save / follow control across the app. The arrays hold entity
 * IDs only; full objects are fetched separately where needed (e.g. the Liked
 * Songs screen via {@link libraryService.getLikedTracks}).
 */
export interface LibraryMembership {
  likedTracks: string[];
  savedAlbums: string[];
  followedArtists: string[];
  savedPlaylists: string[];
}

interface MutationResult {
  success: boolean;
}

/**
 * Normalize the `GET /library` payload to a {@link LibraryMembership}.
 *
 * The backend contract returns `{ likedTracks, savedAlbums, followedArtists,
 * savedPlaylists }`. We defensively coerce each field to a string array so a
 * partial or legacy payload (e.g. the `UserLibrary` shape that exposes
 * `playlists` instead of `savedPlaylists`) never produces `undefined` Sets
 * downstream.
 */
function normalizeMembership(raw: Partial<LibraryMembership> & { playlists?: string[] }): LibraryMembership {
  const toIds = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

  return {
    likedTracks: toIds(raw.likedTracks),
    savedAlbums: toIds(raw.savedAlbums),
    followedArtists: toIds(raw.followedArtists),
    savedPlaylists: toIds(raw.savedPlaylists ?? raw.playlists),
  };
}

/**
 * Library API service.
 *
 * Handles user library operations (liked tracks, saved albums, followed
 * artists, saved playlists). Every mutation is idempotent and resolves once
 * the server has persisted the change; UI optimism lives in the React Query
 * layer ({@link file://./../hooks/useLibrary.ts}).
 */
export const libraryService = {
  /** Membership source for ALL like/save/follow buttons. */
  async getLibrary(): Promise<LibraryMembership> {
    const response = await api.get<Partial<LibraryMembership> & { playlists?: string[] }>('/library');
    return normalizeMembership(response.data);
  },

  /** Full liked-track objects (used by the Liked Songs screen). */
  async getLikedTracks(params?: { limit?: number; offset?: number }): Promise<{ tracks: Track[]; total: number }> {
    const response = await api.get<{ tracks: Track[]; total: number }>('/library/tracks', params);
    return response.data;
  },

  async likeTrack(trackId: string): Promise<MutationResult> {
    const response = await api.post<MutationResult>(`/library/tracks/${trackId}/like`);
    return response.data;
  },

  async unlikeTrack(trackId: string): Promise<MutationResult> {
    const response = await api.post<MutationResult>(`/library/tracks/${trackId}/unlike`);
    return response.data;
  },

  async saveAlbum(albumId: string): Promise<MutationResult> {
    const response = await api.post<MutationResult>(`/library/albums/${albumId}/save`);
    return response.data;
  },

  async unsaveAlbum(albumId: string): Promise<MutationResult> {
    const response = await api.post<MutationResult>(`/library/albums/${albumId}/unsave`);
    return response.data;
  },

  async followArtist(artistId: string): Promise<MutationResult> {
    const response = await api.post<MutationResult>(`/library/artists/${artistId}/follow`);
    return response.data;
  },

  async unfollowArtist(artistId: string): Promise<MutationResult> {
    const response = await api.post<MutationResult>(`/library/artists/${artistId}/unfollow`);
    return response.data;
  },

  async savePlaylist(playlistId: string): Promise<MutationResult> {
    const response = await api.post<MutationResult>(`/library/playlists/${playlistId}/save`);
    return response.data;
  },

  async unsavePlaylist(playlistId: string): Promise<MutationResult> {
    const response = await api.post<MutationResult>(`/library/playlists/${playlistId}/unsave`);
    return response.data;
  },
};
