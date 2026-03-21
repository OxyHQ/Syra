/**
 * Search-related types for Syra music streaming app
 */

import { Track } from './track';
import { Album } from './album';
import { Artist } from './artist';
import { Playlist } from './playlist';

/**
 * Search result categories
 */
export enum SearchCategory {
  ALL = 'all',
  TRACKS = 'tracks',
  ALBUMS = 'albums',
  ARTISTS = 'artists',
  PLAYLISTS = 'playlists'
}

/**
 * Search filters
 */
export interface SearchFilters {
  category?: SearchCategory;
  genre?: string[];
  year?: number;
  explicit?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Search results by category
 */
export interface SearchResultsByCategory {
  tracks?: Track[];
  albums?: Album[];
  artists?: Artist[];
  playlists?: Playlist[];
}

/**
 * Search result counts
 */
export interface SearchResultCounts {
  tracks: number;
  albums: number;
  artists: number;
  playlists: number;
  total: number;
}

/**
 * Search result - unified search response
 */
export interface SearchResult {
  query: string;
  results: SearchResultsByCategory;
  counts: SearchResultCounts;
  hasMore: boolean;
  offset: number;
  limit: number;
}

/**
 * Search request
 */
export interface SearchRequest {
  query: string;
  filters?: SearchFilters;
}






