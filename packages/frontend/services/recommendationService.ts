import { api } from '@/utils/api';
import { Track, Artist } from '@syra/shared-types';
import { normalizeTrackImages, normalizeArtistImages } from '@/utils/catalogImages';

export interface RelatedArtistsResponse {
  artists: Artist[];
  total: number;
}

export interface SimilarTracksResponse {
  tracks: Track[];
  total: number;
}

export interface RadioResponse {
  tracks: Track[];
  total: number;
}

export interface MadeForYouResponse {
  tracks: Track[];
  artists: Artist[];
  /** False when the result is a cold-start popularity fallback, not learned. */
  personalized: boolean;
}

/**
 * Recommendation API service.
 *
 * Surfaces the backend's taste-learning engine: collaborative related artists /
 * similar tracks (mined from everyone's listening), seedable radio for autoplay,
 * and the signed-in user's personalised "Made For You".
 */
export const recommendationService = {
  /** Artists fans of `artistId` also listen to. Public. */
  async getRelatedArtists(artistId: string, params?: { limit?: number }): Promise<RelatedArtistsResponse> {
    const response = await api.get<RelatedArtistsResponse>(`/artists/${artistId}/related`, params);
    return { ...response.data, artists: response.data.artists.map(normalizeArtistImages) };
  },

  /** Tracks similar to `trackId`. Public. */
  async getSimilarTracks(trackId: string, params?: { limit?: number }): Promise<SimilarTracksResponse> {
    const response = await api.get<SimilarTracksResponse>(`/tracks/${trackId}/similar`, params);
    return { ...response.data, tracks: response.data.tracks.map(normalizeTrackImages) };
  },

  /** A radio station seeded from `trackId` for autoplay queue population. Public. */
  async getTrackRadio(trackId: string, params?: { limit?: number }): Promise<RadioResponse> {
    const response = await api.get<RadioResponse>(`/tracks/${trackId}/radio`, params);
    return { ...response.data, tracks: response.data.tracks.map(normalizeTrackImages) };
  },

  /** Personalised tracks + artists for the signed-in user. Requires auth. */
  async getMadeForYou(params?: { limit?: number }): Promise<MadeForYouResponse> {
    const response = await api.get<MadeForYouResponse>('/recommendations/made-for-you', params);
    return {
      tracks: response.data.tracks.map(normalizeTrackImages),
      artists: response.data.artists.map(normalizeArtistImages),
      personalized: response.data.personalized,
    };
  },
};
