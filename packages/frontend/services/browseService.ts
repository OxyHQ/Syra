import { api } from '@/utils/api';
import {
  albumSchema,
  artistSchema,
  playlistSchema,
  trackSchema,
  type Album,
  type Artist,
  type Playlist,
  type Track,
} from '@syra/shared-types';
import { z } from 'zod';
import {
  normalizeAlbumImages,
  normalizeArtistImages,
  normalizePlaylistImages,
  normalizeTrackImages,
  resolveCatalogImageUrl,
} from '@/utils/catalogImages';

const trackResponseSchema = trackSchema.passthrough();
const albumResponseSchema = albumSchema.passthrough();
const artistResponseSchema = artistSchema.passthrough();
const playlistResponseSchema = playlistSchema.passthrough();

const popularTracksResponseSchema = z.object({
  tracks: z.array(trackResponseSchema),
  total: z.number(),
  hasMore: z.boolean(),
}).passthrough();
const popularAlbumsResponseSchema = z.object({
  albums: z.array(albumResponseSchema),
  total: z.number(),
  hasMore: z.boolean(),
}).passthrough();
const popularArtistsResponseSchema = z.object({
  artists: z.array(artistResponseSchema),
  total: z.number(),
  hasMore: z.boolean(),
}).passthrough();
const madeForYouResponseSchema = z.object({
  albums: z.array(albumResponseSchema),
  playlists: z.array(playlistResponseSchema),
  tracks: z.array(trackResponseSchema).optional(),
  artists: z.array(artistResponseSchema).optional(),
  personalized: z.boolean().optional(),
}).passthrough();
const homeBrowseResponseSchema = z.object({
  madeForYou: madeForYouResponseSchema,
  popularAlbums: popularAlbumsResponseSchema,
  popularArtists: popularArtistsResponseSchema,
  tracks: popularTracksResponseSchema,
}).passthrough();
const genreResponseSchema = z.object({
  name: z.string(),
  color: z.string(),
  coverArt: z.string().nullable(),
}).passthrough();
const genresResponseSchema = z.object({
  genres: z.array(genreResponseSchema),
}).passthrough();
const chartsResponseSchema = z.object({
  tracks: z.array(trackResponseSchema),
  total: z.number(),
}).passthrough();

function parseBrowseResponse<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Invalid ${label} response: ${parsed.error.message}`);
  }
  return parsed.data;
}

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
  /** Personalised picks (present for authenticated users). */
  tracks?: Track[];
  artists?: Artist[];
  /** False when the result is a cold-start popularity fallback, not learned. */
  personalized?: boolean;
}

export interface ChartsResponse {
  tracks: Track[];
  total: number;
}

export interface GenreTracksResponse {
  tracks: Track[];
  total: number;
  hasMore: boolean;
}

export interface HomeBrowseResponse {
  madeForYou: MadeForYouResponse;
  popularAlbums: PopularAlbumsResponse;
  popularArtists: PopularArtistsResponse;
  tracks: PopularTracksResponse;
}

/**
 * Browse/Explore API service
 * Handles fetching browse and discovery content
 * Track-bearing browse reads use the linked Oxy client so the backend can apply
 * session-scoped playback preferences while guests still receive public data.
 */
export const browseService = {
  /**
   * Get the home discovery payload in one round-trip.
   */
  async getHome(params?: { sectionLimit?: number; tracksLimit?: number }): Promise<HomeBrowseResponse> {
    const response = await api.get<unknown>('/browse/home', params);
    const data = parseBrowseResponse(homeBrowseResponseSchema, response.data, 'browse home');
    return {
      madeForYou: {
        albums: data.madeForYou.albums.map(normalizeAlbumImages),
        playlists: data.madeForYou.playlists.map(normalizePlaylistImages),
        tracks: data.madeForYou.tracks?.map(normalizeTrackImages),
        artists: data.madeForYou.artists?.map(normalizeArtistImages),
        personalized: data.madeForYou.personalized,
      },
      popularAlbums: {
        ...data.popularAlbums,
        albums: data.popularAlbums.albums.map(normalizeAlbumImages),
      },
      popularArtists: {
        ...data.popularArtists,
        artists: data.popularArtists.artists.map(normalizeArtistImages),
      },
      tracks: {
        ...data.tracks,
        tracks: data.tracks.tracks.map(normalizeTrackImages),
      },
    };
  },

  /**
   * Get available genres with sample content
   */
  async getGenres(): Promise<{ genres: Genre[] }> {
    const response = await api.get<unknown>('/browse/genres');
    const data = parseBrowseResponse(genresResponseSchema, response.data, 'genres');
    return {
      genres: data.genres.map((genre) => ({
        ...genre,
        coverArt: resolveCatalogImageUrl(genre.coverArt) ?? null,
      })),
    };
  },

  /**
   * Get playable tracks for a genre
   */
  async getGenreTracks(
    genre: string,
    params?: { limit?: number; offset?: number },
  ): Promise<GenreTracksResponse> {
    const response = await api.get<unknown>(
      `/browse/genres/${encodeURIComponent(genre)}/tracks`,
      params,
    );
    const data = parseBrowseResponse(popularTracksResponseSchema, response.data, 'genre tracks');
    return { ...data, tracks: data.tracks.map(normalizeTrackImages) };
  },

  /**
   * Get popular/trending tracks
   */
  async getPopularTracks(params?: { limit?: number; offset?: number }): Promise<PopularTracksResponse> {
    const response = await api.get<unknown>('/browse/popular/tracks', params);
    const data = parseBrowseResponse(popularTracksResponseSchema, response.data, 'popular tracks');
    return { ...data, tracks: data.tracks.map(normalizeTrackImages) };
  },

  /**
   * Get popular/trending albums
   */
  async getPopularAlbums(params?: { limit?: number; offset?: number }): Promise<PopularAlbumsResponse> {
    const response = await api.get<unknown>('/browse/popular/albums', params);
    const data = parseBrowseResponse(popularAlbumsResponseSchema, response.data, 'popular albums');
    return { ...data, albums: data.albums.map(normalizeAlbumImages) };
  },

  /**
   * Get popular/trending artists
   */
  async getPopularArtists(params?: { limit?: number; offset?: number }): Promise<PopularArtistsResponse> {
    const response = await api.get<unknown>('/browse/popular/artists', params);
    const data = parseBrowseResponse(popularArtistsResponseSchema, response.data, 'popular artists');
    return { ...data, artists: data.artists.map(normalizeArtistImages) };
  },

  /**
   * Get made for you recommendations
   */
  async getMadeForYou(params?: { limit?: number }): Promise<MadeForYouResponse> {
    const response = await api.get<unknown>('/browse/made-for-you', params);
    const data = parseBrowseResponse(madeForYouResponseSchema, response.data, 'made for you');
    return {
      albums: data.albums.map(normalizeAlbumImages),
      playlists: data.playlists.map(normalizePlaylistImages),
      tracks: data.tracks?.map(normalizeTrackImages),
      artists: data.artists?.map(normalizeArtistImages),
      personalized: data.personalized,
    };
  },

  /**
   * Get top charts
   */
  async getCharts(params?: { limit?: number }): Promise<ChartsResponse> {
    const response = await api.get<unknown>('/browse/charts', params);
    const data = parseBrowseResponse(chartsResponseSchema, response.data, 'charts');
    return { ...data, tracks: data.tracks.map(normalizeTrackImages) };
  },
};
