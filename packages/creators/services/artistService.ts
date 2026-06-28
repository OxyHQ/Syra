import { z } from 'zod';
import {
  artistSchema,
  artistDashboardSchema,
  artistInsightsSchema,
  type Artist,
  type ArtistDashboard,
  type ArtistInsights,
  type CreateArtistRequest,
} from '@syra/shared-types';
import { api, getHttpStatus } from '@/utils/api';

// Backend serializers may include fields beyond the contract; `passthrough`
// keeps the parse from dropping or rejecting them.
const artistResponseSchema = artistSchema.passthrough();
const nullableArtistResponseSchema = artistResponseSchema.nullable();
const artistDashboardResponseSchema = artistDashboardSchema
  .extend({ artist: artistResponseSchema })
  .passthrough();
const artistInsightsResponseSchema = artistInsightsSchema.passthrough();

function parse<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid ${label} response: ${result.error.message}`);
  }
  return result.data;
}

export type InsightsPeriod = '7days' | '30days' | 'alltime';

/**
 * Creator-studio artist API service. Every call goes through the linked,
 * authenticated Syra client; responses are parsed at this boundary so hooks and
 * screens consume typed data.
 */
export const artistService = {
  /** Create the signed-in user's artist profile. */
  async registerAsArtist(input: CreateArtistRequest): Promise<Artist> {
    const response = await api.post<unknown>('/artists/register', input);
    return parse(artistResponseSchema, response.data, 'artist registration');
  },

  /** The signed-in user's artist profile, or null if they have not registered. */
  async getMyArtistProfile(): Promise<Artist | null> {
    try {
      const response = await api.get<unknown>('/artists/me');
      return parse(nullableArtistResponseSchema, response.data, 'artist profile');
    } catch (error) {
      // A missing profile is expected (not an error); surface everything else.
      if (getHttpStatus(error) === 404) return null;
      throw error;
    }
  },

  /** Dashboard rollup: stats, recent tracks/albums, and strike state. */
  async getArtistDashboard(): Promise<ArtistDashboard> {
    const response = await api.get<unknown>('/artists/me/dashboard');
    return parse(artistDashboardResponseSchema, response.data, 'artist dashboard');
  },

  /** Listener insights for a period (plays, listeners, followers, top tracks). */
  async getArtistInsights(period: InsightsPeriod): Promise<ArtistInsights> {
    const response = await api.get<unknown>('/artists/me/insights', { period });
    return parse(artistInsightsResponseSchema, response.data, 'artist insights');
  },
};
