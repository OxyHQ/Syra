import { z } from 'zod';
import {
  podcastSchema,
  episodeSchema,
  type Podcast,
  type Episode,
  type CreatePodcastRequest,
} from '@syra/shared-types';
import { api } from '@/utils/api';
import { RSS_PUBLIC_BASE } from '@/config';

// Backend serializers may include fields beyond the contract; `passthrough`
// keeps the parse from dropping or rejecting them.
const podcastResponseSchema = podcastSchema.passthrough();
const episodeResponseSchema = episodeSchema.passthrough();

const podcastListSchema = z.object({ data: z.array(podcastResponseSchema) });
const podcastDetailSchema = z.object({
  data: z.object({
    podcast: podcastResponseSchema,
    episodes: z.array(episodeResponseSchema),
  }),
});
const episodeListSchema = z.object({
  data: z.array(episodeResponseSchema),
  total: z.number().optional(),
  page: z.number().optional(),
  limit: z.number().optional(),
});
const createPodcastResponseSchema = z.object({ data: podcastResponseSchema });

function parse<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid ${label} response: ${result.error.message}`);
  }
  return result.data;
}

export interface PodcastDetail {
  podcast: Podcast;
  episodes: Episode[];
}

export interface EpisodePage {
  episodes: Episode[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Creator-studio podcast API service. Every call goes through the linked,
 * authenticated Syra client; responses are parsed at this boundary so hooks and
 * screens consume typed data.
 */
export const podcastService = {
  /** Shows owned by the signed-in creator, newest first. */
  async getMyPodcasts(): Promise<Podcast[]> {
    const response = await api.get<unknown>('/podcasts/mine');
    return parse(podcastListSchema, response.data, 'my podcasts').data;
  },

  /** A single show plus its most recent episodes (owner sees all statuses). */
  async getPodcast(id: string): Promise<PodcastDetail> {
    const response = await api.get<unknown>(`/podcasts/${id}`);
    return parse(podcastDetailSchema, response.data, 'podcast detail').data;
  },

  /** A reverse-chronological page of a show's episodes. */
  async getEpisodes(id: string, params?: { page?: number; limit?: number }): Promise<EpisodePage> {
    const response = await api.get<unknown>(`/podcasts/${id}/episodes`, params);
    const parsed = parse(episodeListSchema, response.data, 'podcast episodes');
    return {
      episodes: parsed.data,
      total: parsed.total ?? parsed.data.length,
      page: parsed.page ?? params?.page ?? 1,
      limit: parsed.limit ?? params?.limit ?? parsed.data.length,
    };
  },

  /** Create a Syra-hosted show. */
  async createPodcast(input: CreatePodcastRequest): Promise<Podcast> {
    const response = await api.post<unknown>('/podcasts', input);
    return parse(createPodcastResponseSchema, response.data, 'create podcast').data;
  },
};

/**
 * The public RSS feed URL for a show. The backend persists `feedUrl` when
 * `STREAM_KEY_BASE_URL` is configured; otherwise we derive the canonical public
 * URL from the show id so creators always have a copyable link.
 */
export function podcastRssUrl(podcast: Pick<Podcast, 'id' | 'feedUrl'>): string {
  if (podcast.feedUrl && /^https?:\/\//.test(podcast.feedUrl)) {
    return podcast.feedUrl;
  }
  return `${RSS_PUBLIC_BASE}/api/podcasts/${podcast.id}/rss`;
}
