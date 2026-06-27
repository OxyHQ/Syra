import { z } from 'zod';
import {
  podcastSchema,
  episodeSchema,
  resolvedPersonSchema,
  podcastSubscriptionsSchema,
  type Podcast,
  type Episode,
  type ResolvedPerson,
  type PodcastSubscriptions,
} from '@syra/shared-types';
import { api, publicApi } from '@/utils/api';

/**
 * Podcast catalog + subscription service.
 *
 * Catalog reads (search / browse / show / episode list) are public and use the
 * unauthenticated `publicApi` client so guests get the same data. Subscription
 * reads/writes and the manual feed import are identity-scoped and go through the
 * linked Oxy `api` client (bearer attached when a session exists).
 *
 * Every response is Zod-parsed at the boundary so backend drift fails loudly in
 * the service layer instead of surfacing as `undefined` deep in the UI.
 *
 * Podcast/episode artwork is intentionally NOT run through the catalog image
 * normalizer — external feed images are plain URLs and Syra-hosted ones are Oxy
 * file ids; both are resolved at render time via `resolvePodcastImageUri`.
 */

const podcastResponseSchema = podcastSchema.passthrough();
const episodeResponseSchema = episodeSchema.passthrough();

const podcastListResponseSchema = z.object({
  data: z.array(podcastResponseSchema),
}).passthrough();

const podcastShowResponseSchema = z.object({
  data: z.object({
    podcast: podcastResponseSchema,
    episodes: z.array(episodeResponseSchema),
    // Show-level Hosts & Guests (resolved Person/Artist + Oxy links). Optional
    // so the client stays resilient across the backend rollout.
    persons: z.array(resolvedPersonSchema.passthrough()).optional(),
  }).passthrough(),
}).passthrough();

const podcastEpisodesResponseSchema = z.object({
  data: z.array(episodeResponseSchema),
  total: z.number(),
  page: z.number().optional(),
  limit: z.number().optional(),
}).passthrough();

const subscriptionsResponseSchema = z.object({
  data: podcastSubscriptionsSchema,
}).passthrough();

const okResponseSchema = z.object({
  ok: z.boolean(),
}).passthrough();

function parsePodcastResponse<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Invalid ${label} response: ${parsed.error.message}`);
  }
  return parsed.data;
}

export type BrowsePodcastsParams = {
  category?: string;
  sort?: 'popular' | 'recent';
  page?: number;
  limit?: number;
};

export interface PodcastEpisodesPage {
  episodes: Episode[];
  total: number;
  page: number;
  limit: number;
}

export const podcastService = {
  /** DB-first text search. Falls back to directory import on the backend. */
  async searchPodcasts(query: string, params?: { limit?: number }): Promise<Podcast[]> {
    const response = await publicApi.get<unknown>('/podcasts/search', { q: query, ...params });
    return parsePodcastResponse(podcastListResponseSchema, response.data, 'podcast search').data;
  },

  /** Browse shows by category / popularity / recency from the catalog. */
  async browsePodcasts(params?: BrowsePodcastsParams): Promise<Podcast[]> {
    const response = await publicApi.get<unknown>('/podcasts', params);
    return parsePodcastResponse(podcastListResponseSchema, response.data, 'podcast browse').data;
  },

  /** A single show plus its most recent episodes and resolved hosts/guests. */
  async getPodcast(id: string): Promise<{ podcast: Podcast; episodes: Episode[]; persons: ResolvedPerson[] }> {
    const response = await publicApi.get<unknown>(`/podcasts/${id}`);
    const data = parsePodcastResponse(podcastShowResponseSchema, response.data, 'podcast').data;
    return { podcast: data.podcast, episodes: data.episodes, persons: data.persons ?? [] };
  },

  /** Paginated, reverse-chronological episodes for a show. */
  async getPodcastEpisodes(
    id: string,
    params?: { page?: number; limit?: number },
  ): Promise<PodcastEpisodesPage> {
    const response = await publicApi.get<unknown>(`/podcasts/${id}/episodes`, params);
    const data = parsePodcastResponse(podcastEpisodesResponseSchema, response.data, 'podcast episodes');
    return {
      episodes: data.data,
      total: data.total,
      page: data.page ?? params?.page ?? 1,
      limit: data.limit ?? params?.limit ?? data.data.length,
    };
  },

  /** The signed-in user's subscribed shows + new-episode signals. */
  async getSubscriptions(): Promise<PodcastSubscriptions> {
    const response = await api.get<unknown>('/podcasts/subscriptions');
    return parsePodcastResponse(subscriptionsResponseSchema, response.data, 'subscriptions').data;
  },

  async subscribe(podcastId: string): Promise<void> {
    const response = await api.post<unknown>(`/podcasts/${podcastId}/subscribe`);
    parsePodcastResponse(okResponseSchema, response.data, 'subscribe');
  },

  async unsubscribe(podcastId: string): Promise<void> {
    const response = await api.post<unknown>(`/podcasts/${podcastId}/unsubscribe`);
    parsePodcastResponse(okResponseSchema, response.data, 'unsubscribe');
  },
};
