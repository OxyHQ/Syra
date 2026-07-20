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
 * similar tracks (mined from everyone's listening) and the signed-in user's
 * personalised "Made For You". Stations live in
 * {@link file://./radioService.ts}, which owns the stateful radio engine.
 *
 * Every read goes through the linked Oxy client: these results vary by identity
 * and by playback preference, so they must be fetched as the current session.
 */
export const recommendationService = {
  /** Artists fans of `artistId` also listen to. Works for guests too. */
  async getRelatedArtists(artistId: string, params?: { limit?: number }): Promise<RelatedArtistsResponse> {
    const response = await api.get<RelatedArtistsResponse>(`/artists/${artistId}/related`, params);
    return { ...response.data, artists: response.data.artists.map(normalizeArtistImages) };
  },

  /** Tracks similar to `trackId`. Works for guests too. */
  async getSimilarTracks(trackId: string, params?: { limit?: number }): Promise<SimilarTracksResponse> {
    const response = await api.get<SimilarTracksResponse>(`/tracks/${trackId}/similar`, params);
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
