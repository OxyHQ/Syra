import { api } from '@/utils/api';
import {
  albumSchema,
  artistSchema,
  episodeSchema,
  playlistSchema,
  podcastSchema,
  searchPersonSchema,
  searchUserSchema,
  trackSchema,
  type SearchCategory,
} from '@syra/shared-types';
import type { SearchResultWithPending } from '@/utils/searchUtils';
import { normalizeSearchImages } from '@/utils/catalogImages';
import { z } from 'zod';

const searchResultWithPendingResponseSchema = z.object({
  query: z.string(),
  results: z.object({
    tracks: z.array(trackSchema.passthrough()).optional(),
    albums: z.array(albumSchema.passthrough()).optional(),
    artists: z.array(artistSchema.passthrough()).optional(),
    playlists: z.array(playlistSchema.passthrough()).optional(),
    podcasts: z.array(podcastSchema.passthrough()).optional(),
    episodes: z.array(episodeSchema.passthrough()).optional(),
    people: z.array(searchPersonSchema.passthrough()).optional(),
    users: z.array(searchUserSchema.passthrough()).optional(),
  }).passthrough(),
  counts: z.object({
    tracks: z.number(),
    albums: z.number(),
    artists: z.number(),
    playlists: z.number(),
    podcasts: z.number(),
    episodes: z.number(),
    people: z.number(),
    users: z.number(),
    total: z.number(),
  }).passthrough(),
  hasMore: z.boolean(),
  offset: z.number(),
  limit: z.number(),
  pendingPodcastImport: z.boolean().optional(),
}).passthrough();

function parseSearchResponse(data: unknown): SearchResultWithPending {
  const parsed = searchResultWithPendingResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Invalid search response: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Search API service
 * Handles music search across tracks, albums, artists, and playlists
 */
export const searchService = {
  async search(
    query: string,
    params?: { category?: SearchCategory; limit?: number; offset?: number },
  ): Promise<SearchResultWithPending> {
    const response = await api.get<unknown>('/search', { q: query, ...params });
    return normalizeSearchImages(parseSearchResponse(response.data));
  },
};
