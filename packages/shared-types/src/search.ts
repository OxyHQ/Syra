import { z } from 'zod';
import { trackSchema } from './track';
import { albumSchema } from './album';
import { artistSchema } from './artist';
import { playlistSchema } from './playlist';

export const searchCategorySchema = z.enum([
  'all',
  'tracks',
  'albums',
  'artists',
  'playlists',
  'users',
]);
export type SearchCategory = z.infer<typeof searchCategorySchema>;
export const SearchCategory = {
  ALL: 'all' as const,
  TRACKS: 'tracks' as const,
  ALBUMS: 'albums' as const,
  ARTISTS: 'artists' as const,
  PLAYLISTS: 'playlists' as const,
  USERS: 'users' as const,
};

export const searchFiltersSchema = z.object({
  category: searchCategorySchema.optional(),
  genre: z.array(z.string()).optional(),
  year: z.number().optional(),
  explicit: z.boolean().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});
export type SearchFilters = z.infer<typeof searchFiltersSchema>;

export const searchUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatar: z.string().optional(),
  bio: z.string().optional(),
  verified: z.boolean().optional(),
  followers: z.number().optional(),
  following: z.number().optional(),
  primaryColor: z.string().optional(),
});
export type SearchUser = z.infer<typeof searchUserSchema>;

export const searchResultsByCategorySchema = z.object({
  tracks: z.array(trackSchema).optional(),
  albums: z.array(albumSchema).optional(),
  artists: z.array(artistSchema).optional(),
  playlists: z.array(playlistSchema).optional(),
  users: z.array(searchUserSchema).optional(),
});
export type SearchResultsByCategory = z.infer<typeof searchResultsByCategorySchema>;

export const searchResultCountsSchema = z.object({
  tracks: z.number(),
  albums: z.number(),
  artists: z.number(),
  playlists: z.number(),
  users: z.number(),
  total: z.number(),
});
export type SearchResultCounts = z.infer<typeof searchResultCountsSchema>;

export const searchResultSchema = z.object({
  query: z.string(),
  results: searchResultsByCategorySchema,
  counts: searchResultCountsSchema,
  hasMore: z.boolean(),
  offset: z.number(),
  limit: z.number(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchRequestSchema = z.object({
  query: z.string(),
  filters: searchFiltersSchema.optional(),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;
