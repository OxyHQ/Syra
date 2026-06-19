import { publicApi } from '@/utils/api';
import { Track, Album, Artist, Playlist } from '@syra/shared-types';
import {
  normalizeAlbumImages,
  normalizeArtistImages,
  normalizePlaylistImages,
  normalizeTrackImages,
  resolveCatalogImageUrl,
} from '@/utils/catalogImages';

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
 */
export const browseService = {
  /**
   * Get the public home discovery payload in one round-trip.
   */
  async getHome(params?: { sectionLimit?: number; tracksLimit?: number }): Promise<HomeBrowseResponse> {
    const response = await publicApi.get<HomeBrowseResponse>('/browse/home', params);
    return {
      madeForYou: {
        albums: response.data.madeForYou.albums.map(normalizeAlbumImages),
        playlists: response.data.madeForYou.playlists.map(normalizePlaylistImages),
        tracks: response.data.madeForYou.tracks?.map(normalizeTrackImages),
        artists: response.data.madeForYou.artists?.map(normalizeArtistImages),
        personalized: response.data.madeForYou.personalized,
      },
      popularAlbums: {
        ...response.data.popularAlbums,
        albums: response.data.popularAlbums.albums.map(normalizeAlbumImages),
      },
      popularArtists: {
        ...response.data.popularArtists,
        artists: response.data.popularArtists.artists.map(normalizeArtistImages),
      },
      tracks: {
        ...response.data.tracks,
        tracks: response.data.tracks.tracks.map(normalizeTrackImages),
      },
    };
  },

  /**
   * Get available genres with sample content
   */
  async getGenres(): Promise<{ genres: Genre[] }> {
    const response = await publicApi.get<{ genres: Genre[] }>('/browse/genres');
    return {
      genres: response.data.genres.map((genre) => ({
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
    const response = await publicApi.get<GenreTracksResponse>(
      `/browse/genres/${encodeURIComponent(genre)}/tracks`,
      params,
    );
    return { ...response.data, tracks: response.data.tracks.map(normalizeTrackImages) };
  },

  /**
   * Get popular/trending tracks
   */
  async getPopularTracks(params?: { limit?: number; offset?: number }): Promise<PopularTracksResponse> {
    const response = await publicApi.get<PopularTracksResponse>('/browse/popular/tracks', params);
    return { ...response.data, tracks: response.data.tracks.map(normalizeTrackImages) };
  },

  /**
   * Get popular/trending albums
   */
  async getPopularAlbums(params?: { limit?: number; offset?: number }): Promise<PopularAlbumsResponse> {
    const response = await publicApi.get<PopularAlbumsResponse>('/browse/popular/albums', params);
    return { ...response.data, albums: response.data.albums.map(normalizeAlbumImages) };
  },

  /**
   * Get popular/trending artists
   */
  async getPopularArtists(params?: { limit?: number; offset?: number }): Promise<PopularArtistsResponse> {
    const response = await publicApi.get<PopularArtistsResponse>('/browse/popular/artists', params);
    return { ...response.data, artists: response.data.artists.map(normalizeArtistImages) };
  },

  /**
   * Get made for you recommendations
   */
  async getMadeForYou(params?: { limit?: number }): Promise<MadeForYouResponse> {
    const response = await publicApi.get<MadeForYouResponse>('/browse/made-for-you', params);
    return {
      albums: response.data.albums.map(normalizeAlbumImages),
      playlists: response.data.playlists.map(normalizePlaylistImages),
      tracks: response.data.tracks?.map(normalizeTrackImages),
      artists: response.data.artists?.map(normalizeArtistImages),
      personalized: response.data.personalized,
    };
  },

  /**
   * Get top charts
   */
  async getCharts(params?: { limit?: number }): Promise<ChartsResponse> {
    const response = await publicApi.get<ChartsResponse>('/browse/charts', params);
    return { ...response.data, tracks: response.data.tracks.map(normalizeTrackImages) };
  },
};
