import { api } from '@/utils/api';
import { Track, Album, Artist, Playlist } from '@syra/shared-types';

export interface Genre {
  name: string;
  color: string;
  coverArt: string | null;
}

export interface PopularTracksResponse {
  tracks: Track[];
  total: number;
  hasMore: boolean;
}

export interface PopularAlbumsResponse {
  albums: Album[];
  total: number;
  hasMore: boolean;
}

export interface PopularArtistsResponse {
  artists: Artist[];
  total: number;
  hasMore: boolean;
}

export interface MadeForYouResponse {
  albums: Album[];
  playlists: Playlist[];
}

export interface ChartsResponse {
  tracks: Track[];
  total: number;
}

/**
 * Browse/Explore API service
 * Handles fetching browse and discovery content
 */
export const browseService = {
  /**
   * Get available genres with sample content
   */
  async getGenres(): Promise<{ genres: Genre[] }> {
    const response = await api.get<{ genres: Genre[] }>('/browse/genres');
    return response.data;
  },

  /**
   * Get popular/trending tracks
   */
  async getPopularTracks(params?: { limit?: number; offset?: number }): Promise<PopularTracksResponse> {
    const response = await api.get<PopularTracksResponse>('/browse/popular/tracks', params);
    return response.data;
  },

  /**
   * Get popular/trending albums
   */
  async getPopularAlbums(params?: { limit?: number; offset?: number }): Promise<PopularAlbumsResponse> {
    const response = await api.get<PopularAlbumsResponse>('/browse/popular/albums', params);
    return response.data;
  },

  /**
   * Get popular/trending artists
   */
  async getPopularArtists(params?: { limit?: number; offset?: number }): Promise<PopularArtistsResponse> {
    const response = await api.get<PopularArtistsResponse>('/browse/popular/artists', params);
    return response.data;
  },

  /**
   * Get made for you recommendations
   */
  async getMadeForYou(params?: { limit?: number }): Promise<MadeForYouResponse> {
    const response = await api.get<MadeForYouResponse>('/browse/made-for-you', params);
    return response.data;
  },

  /**
   * Get top charts
   */
  async getCharts(params?: { limit?: number }): Promise<ChartsResponse> {
    const response = await api.get<ChartsResponse>('/browse/charts', params);
    return response.data;
  },
};

