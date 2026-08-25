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
 * DISCOVERY reads — search and browse — are public and use the unauthenticated
 * `publicApi` client, so guests get the same data. They serve only listable
 * shows and no identity can change their answer.
 *
 * Reads addressed BY ID go through the linked Oxy `api` client, which attaches
 * a bearer when a session exists and sends none when it does not. They are not
 * public: `viewerCanReadShowFilter` reads a private or unpublished show for its
 * OWNER and for nobody else, so a request that omits the caller is a request
 * that claims to be a stranger. Reading them anonymously answered 404 to a
 * creator opening their own private show from their own library.
 *
 * Subscription reads/writes and the manual feed import are identity-scoped and
 * have always used the linked client.
 *
 * ## The two clients do not deliver the same thing
 *
 * `publicApi` is plain axios: `response.data` is the RAW body, envelope and all.
 * `api` is the linked Oxy client, which UNWRAPS a `{ data: … }` body before
 * returning it — measured against the installed package, not assumed: a body of
 * `{"data":[{"id":"a"}]}` comes back as `[{"id":"a"}]`.
 *
 * So each schema describes the shape ITS OWN client delivers, and the two are
 * named apart (`…Payload` vs `…Envelope`). Sharing one across both is how
 * `getMyPodcasts` came to throw on every single call: it parsed an unwrapped
 * payload with a schema that demanded an envelope, so a creator with two shows
 * was told, in the empty state's own words, that they had none.
 *
 * A `{ ok: true }` body has no `data` key, so the client returns it untouched
 * and one schema serves both clients.
 *
 * Every response is Zod-parsed at the boundary so backend drift fails loudly in
 * the service layer instead of surfacing as `undefined` deep in the UI.
 *
 * Podcast/episode artwork carries a Syra-hosted `image` id (+ `imageSizes`) with
 * the original external `imageSourceUrl` as a fallback; both are resolved at
 * render time via the shared catalog picker `resolvePodcastArtwork` (Syra-hosted
 * first, external URL last).
 */

const podcastResponseSchema = podcastSchema.passthrough();
const episodeResponseSchema = episodeSchema.passthrough();

/** A list of shows. `publicApi` sees the envelope; `api` sees the payload. */
const podcastListPayloadSchema = z.array(podcastResponseSchema);
const podcastListEnvelopeSchema = z.object({
  data: podcastListPayloadSchema,
}).passthrough();

/** One show with its first page of episodes. Read by id, so `api` only. */
const podcastShowPayloadSchema = z.object({
  podcast: podcastResponseSchema,
  episodes: z.array(episodeResponseSchema),
  // Show-level Hosts & Guests (resolved Person/Artist + Oxy links). Optional
  // so the client stays resilient across the backend rollout.
  persons: z.array(resolvedPersonSchema.passthrough()).optional(),
}).passthrough();

/**
 * A show's episodes. The server sends `{ data: [...], total, page, limit }` and
 * the linked client returns only `data`, dropping the other three — which costs
 * nothing, because nothing has ever read them: the one consumer takes
 * `episodesQuery.data` and renders it. They are not reconstructed here, because
 * carrying three fields no screen asks for is how they came to look load-bearing.
 */
const podcastEpisodesPayloadSchema = z.array(episodeResponseSchema);

/** The caller's subscriptions. Identity-scoped, so `api` only. */
const subscriptionsPayloadSchema = podcastSubscriptionsSchema;

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

export const podcastService = {
  /** DB-first text search. Falls back to directory import on the backend. */
  async searchPodcasts(query: string, params?: { limit?: number }): Promise<Podcast[]> {
    const response = await publicApi.get<unknown>('/podcasts/search', { q: query, ...params });
    return parsePodcastResponse(podcastListEnvelopeSchema, response.data, 'podcast search').data;
  },

  /** Browse shows by category / popularity / recency from the catalog. */
  async browsePodcasts(params?: BrowsePodcastsParams): Promise<Podcast[]> {
    const response = await publicApi.get<unknown>('/podcasts', params);
    return parsePodcastResponse(podcastListEnvelopeSchema, response.data, 'podcast browse').data;
  },

  /** A single show plus its most recent episodes and resolved hosts/guests. */
  async getPodcast(id: string): Promise<{ podcast: Podcast; episodes: Episode[]; persons: ResolvedPerson[] }> {
    const response = await api.get<unknown>(`/podcasts/${id}`);
    const data = parsePodcastResponse(podcastShowPayloadSchema, response.data, 'podcast');
    return { podcast: data.podcast, episodes: data.episodes, persons: data.persons ?? [] };
  },

  /** One page of a show's episodes, newest first. */
  async getPodcastEpisodes(id: string, params?: { page?: number; limit?: number }): Promise<Episode[]> {
    const response = await api.get<unknown>(`/podcasts/${id}/episodes`, params);
    return parsePodcastResponse(podcastEpisodesPayloadSchema, response.data, 'podcast episodes');
  },

  /**
   * Shows the signed-in user OWNS, newest first, in every state.
   *
   * Deliberately unfiltered by `status` and `visibility` — the owner filter IS
   * the access control, and a creator's private, unpublished and taken-down
   * shows are exactly the ones they need to find. The library surfaces label
   * each show's state rather than hiding it, since a show missing from the one
   * screen that could unhide it is the bug this endpoint exists to avoid.
   *
   * The same endpoint the creator portal reads. It is not duplicated here for
   * the listener app's sake: listing owned shows is one server behaviour, and a
   * second route answering it is a second thing to keep in agreement.
   */
  async getMyPodcasts(): Promise<Podcast[]> {
    const response = await api.get<unknown>('/podcasts/mine');
    return parsePodcastResponse(podcastListPayloadSchema, response.data, 'my podcasts');
  },

  /** The signed-in user's subscribed shows + new-episode signals. */
  async getSubscriptions(): Promise<PodcastSubscriptions> {
    const response = await api.get<unknown>('/podcasts/subscriptions');
    return parsePodcastResponse(subscriptionsPayloadSchema, response.data, 'subscriptions');
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
