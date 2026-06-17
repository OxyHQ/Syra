import { api } from '@/utils/api';
import { Track } from '@syra/shared-types';
import { createScopedLogger } from '@/utils/logger';
import { normalizeTrackImages } from '@/utils/catalogImages';

const logger = createScopedLogger('LibraryService');

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

/** Backend ack for a recorded play (`POST /library/recently-played`). */
interface RecordPlayResult {
  ok: boolean;
}

/**
 * Where a play was initiated from. Sent with the play signal so the
 * recommendation engine can weight taste by intent (a searched play is a
 * stronger signal than an algorithmically-queued radio play). Must mirror the
 * backend `ListeningSource` union.
 */
export type ListeningSource =
  | 'search'
  | 'library'
  | 'playlist'
  | 'album'
  | 'artist'
  | 'radio'
  | 'recommendation'
  | 'charts'
  | 'queue'
  | 'unknown';

/**
 * Optional engagement signals accompanying a recorded play. When the player
 * knows how much of the track was actually heard it sends `listenedSec` (and/or
 * an explicit `completion` ratio) so the backend can distinguish a real play
 * from a skip — the foundation of taste learning and honest popularity.
 */
export interface PlaySignal {
  listenedSec?: number;
  completion?: number;
  source?: ListeningSource;
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
    return { ...response.data, tracks: response.data.tracks.map(normalizeTrackImages) };
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

  /**
   * The authenticated user's most-recently-played tracks, newest first.
   *
   * Backed by `GET /library/recently-played`. Populated by
   * {@link libraryService.recordRecentlyPlayed}, which the player calls when a
   * track actually starts. Returns an empty list for users with no play
   * history; the home screen hides the section in that case rather than faking
   * it.
   */
  async getRecentlyPlayed(limit: number = 20): Promise<{ tracks: Track[] }> {
    const response = await api.get<{ tracks: Track[] }>('/library/recently-played', { limit });
    const tracks = Array.isArray(response.data?.tracks) ? response.data.tracks : [];
    return { tracks: tracks.map(normalizeTrackImages) };
  },

  /**
   * Record a play of `trackId` for the authenticated user (newest first).
   *
   * Fire-and-forget from the player: it must never block or surface a playback
   * error to the user. Failures (offline, non-2xx, unauthenticated) are logged
   * at warn level and swallowed so playback continues uninterrupted. Resolves
   * `false` instead of throwing so callers can stay synchronous-friendly.
   */
  async recordRecentlyPlayed(trackId: string, signal?: PlaySignal): Promise<boolean> {
    try {
      const response = await api.post<RecordPlayResult>('/library/recently-played', {
        trackId,
        ...(signal?.listenedSec !== undefined ? { listenedSec: signal.listenedSec } : {}),
        ...(signal?.completion !== undefined ? { completion: signal.completion } : {}),
        ...(signal?.source ? { source: signal.source } : {}),
      });
      return response.data?.ok === true;
    } catch (error) {
      logger.warn('Failed to record recently-played', { trackId, error });
      return false;
    }
  },
};
