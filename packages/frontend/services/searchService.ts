import { api } from '@/utils/api';
import { SearchCategory } from '@syra/shared-types';
import type { SearchResultWithPending } from '@/utils/searchUtils';
import { normalizeSearchImages } from '@/utils/catalogImages';

/**
 * Search API service
 * Handles music search across tracks, albums, artists, and playlists
 */
export const searchService = {
  async search(
    query: string,
    params?: { category?: SearchCategory; limit?: number; offset?: number },
  ): Promise<SearchResultWithPending> {
    const response = await api.get<SearchResultWithPending>('/search', { q: query, ...params });
    return normalizeSearchImages(response.data);
  },
};
