import { api } from '@/utils/api';
import { SearchResult, SearchCategory } from '@syra/shared-types';

/**
 * Search API service
 * Handles music search across tracks, albums, artists, and playlists
 */
export const searchService = {
  async search(query: string, params?: { category?: SearchCategory; limit?: number; offset?: number }): Promise<SearchResult> {
    const response = await api.get<SearchResult>('/search', { q: query, ...params });
    return response.data;
  },
};
