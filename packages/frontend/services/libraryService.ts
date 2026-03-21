import { api } from '@/utils/api';
import { Track, Album, Artist, UserLibrary } from '@syra/shared-types';

/**
 * Library API service
 * Handles user library operations (liked tracks, saved albums, followed artists)
 */
export const libraryService = {
  async getUserLibrary(): Promise<UserLibrary> {
    const response = await api.get<UserLibrary>('/library');
    return response.data;
  },

  async getLikedTracks(params?: { limit?: number; offset?: number }): Promise<{ tracks: Track[]; total: number; oxyUserId: string }> {
    const response = await api.get<{ tracks: Track[]; total: number; oxyUserId: string }>('/library/tracks', params);
    return response.data;
  },

  async likeTrack(trackId: string): Promise<{ success: boolean }> {
    const response = await api.post<{ success: boolean }>(`/library/tracks/${trackId}/like`);
    return response.data;
  },

  async unlikeTrack(trackId: string): Promise<{ success: boolean }> {
    const response = await api.post<{ success: boolean }>(`/library/tracks/${trackId}/unlike`);
    return response.data;
  },
};

