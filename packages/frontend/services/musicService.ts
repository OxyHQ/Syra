import { api } from '@/utils/api';
import { Track, Album, Artist, Playlist } from '@syra/shared-types';

/**
 * Music API service
 * Handles all music-related API calls
 * Uses api client which sends auth token if available, but backend handles public routes gracefully
 */
export const musicService = {
  // Tracks
  async getTracks(params?: { limit?: number; offset?: number }): Promise<{ tracks: Track[]; total: number; hasMore: boolean }> {
    const response = await api.get<{ tracks: Track[]; total: number; hasMore: boolean }>('/tracks', params);
    return response.data;
  },

  async getTrackById(id: string): Promise<Track> {
    const response = await api.get<Track>(`/tracks/${id}`);
    return response.data;
  },

  async searchTracks(query: string, params?: { limit?: number; offset?: number }): Promise<{ tracks: Track[]; total: number; hasMore: boolean }> {
    const response = await api.get<{ tracks: Track[]; total: number; hasMore: boolean }>('/tracks/search', { q: query, ...params });
    return response.data;
  },

  // Albums
  async getAlbums(params?: { limit?: number; offset?: number }): Promise<{ albums: Album[]; total: number; hasMore: boolean }> {
    const response = await api.get<{ albums: Album[]; total: number; hasMore: boolean }>('/albums', params);
    return response.data;
  },

  async getAlbumById(id: string): Promise<Album> {
    const response = await api.get<Album>(`/albums/${id}`);
    return response.data;
  },

  async getAlbumTracks(albumId: string): Promise<{ tracks: Track[] }> {
    const response = await api.get<{ tracks: Track[] }>(`/albums/${albumId}/tracks`);
    return response.data;
  },

  // Artists
  async getArtists(params?: { limit?: number; offset?: number }): Promise<{ artists: Artist[]; total: number; hasMore: boolean }> {
    const response = await api.get<{ artists: Artist[]; total: number; hasMore: boolean }>('/artists', params);
    return response.data;
  },

  async getArtistById(id: string): Promise<Artist> {
    const response = await api.get<Artist>(`/artists/${id}`);
    return response.data;
  },

  async getArtistAlbums(artistId: string): Promise<{ albums: Album[] }> {
    const response = await api.get<{ albums: Album[] }>(`/artists/${artistId}/albums`);
    return response.data;
  },

  async getArtistTracks(artistId: string, params?: { limit?: number; offset?: number }): Promise<{ tracks: Track[]; total: number; hasMore: boolean }> {
    const response = await api.get<{ tracks: Track[]; total: number; hasMore: boolean }>(`/artists/${artistId}/tracks`, params);
    return response.data;
  },

  async followArtist(artistId: string): Promise<{ success: boolean }> {
    const response = await api.post<{ success: boolean }>(`/artists/${artistId}/follow`);
    return response.data;
  },

  async unfollowArtist(artistId: string): Promise<{ success: boolean }> {
    const response = await api.post<{ success: boolean }>(`/artists/${artistId}/unfollow`);
    return response.data;
  },

  // Playlists
  async getPlaylistById(id: string): Promise<Playlist> {
    const response = await api.get<Playlist>(`/playlists/${id}`);
    return response.data;
  },

  async getPlaylistTracks(playlistId: string): Promise<{ tracks: Track[]; total: number }> {
    const response = await api.get<{ tracks: Track[]; total: number }>(`/playlists/${playlistId}/tracks`);
    return response.data;
  },

  async getUserPlaylists(): Promise<{ playlists: Playlist[]; total: number }> {
    const response = await api.get<{ playlists: Playlist[]; total: number }>('/playlists');
    return response.data;
  },

  async createPlaylist(data: { 
    name: string; 
    description?: string; 
    coverArt?: string; 
    isPublic?: boolean;
    visibility?: string;
  }): Promise<Playlist> {
    const response = await api.post<Playlist>('/playlists', data);
    return response.data;
  },
};

