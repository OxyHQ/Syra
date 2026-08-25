import { z } from 'zod';
import {
  episodeSchema,
  resolvedPersonSchema,
  updateEpisodeProgressRequestSchema,
  type Episode,
  type ResolvedPerson,
  type UpdateEpisodeProgressRequest,
} from '@syra/shared-types';
import { api } from '@/utils/api';

/**
 * Episode service — episode detail (with resolved hosts/guests and the caller's
 * saved progress), playback-progress writes, and the "continue listening" list.
 *
 * The episode endpoints are public reads but progress-enriched for an
 * authenticated caller, so they go through the linked Oxy `api` client: a guest
 * receives the episode without progress, a signed-in user receives their resume
 * position. Hooks separate the React Query cache keys by identity so a guest
 * cold-boot response never poisons the authenticated cache.
 *
 * Progress writes require a session and are best-effort from the player.
 */

const episodeResponseSchema = episodeSchema.passthrough();

const episodeDetailResponseSchema = z.object({
  data: z.object({
    episode: episodeResponseSchema,
    persons: z.array(resolvedPersonSchema.passthrough()),
    progressSec: z.number().optional(),
    completed: z.boolean().optional(),
  }).passthrough(),
}).passthrough();

const continueListeningResponseSchema = z.object({
  data: z.array(z.object({
    episode: episodeResponseSchema,
    progressSec: z.number(),
    durationSec: z.number(),
    completed: z.boolean(),
  }).passthrough()),
}).passthrough();

const progressWriteResponseSchema = z.object({
  ok: z.boolean(),
  positionSec: z.number().optional(),
  completed: z.boolean().optional(),
}).passthrough();

export interface EpisodeDetail {
  episode: Episode;
  persons: ResolvedPerson[];
  progressSec?: number;
  completed?: boolean;
}

export interface ContinueListeningEntry {
  episode: Episode;
  progressSec: number;
  durationSec: number;
  completed: boolean;
}

function parseEpisodeResponse<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Invalid ${label} response: ${parsed.error.message}`);
  }
  return parsed.data;
}

export const episodeService = {
  /**
   * Episode detail + resolved persons.
   *
   * Read through the LINKED client, because the content is not identity-
   * independent: an episode of a private or unpublished show is readable by
   * that show's owner and by nobody else, and the server can only apply that
   * rule to a request that says who is asking. Reading it anonymously made a
   * creator a stranger to their own episode.
   *
   * This used to go through `publicApi` to avoid the linked client stalling on
   * an Oxy session refresh and blocking the episode from ever loading. That
   * concern is real and is answered where it belongs: `useEpisode` is
   * `enabled: isResolved`, so the read waits for the session to reach a
   * terminal identity — guest or signed in — and `useAuthGate` bounds that wait
   * with its own timeout. Dropping the identity was the wrong place to fix it.
   *
   * Per-user saved position is fetched separately via `useEpisodeProgress` (the
   * continue-listening cache), so it is intentionally not requested here.
   */
  async getEpisode(id: string): Promise<EpisodeDetail> {
    const response = await api.get<unknown>(`/episodes/${id}`);
    return parseEpisodeResponse(episodeDetailResponseSchema, response.data, 'episode').data;
  },

  /** Upsert the caller's playback position for an episode. */
  async saveProgress(input: UpdateEpisodeProgressRequest): Promise<void> {
    const payload = updateEpisodeProgressRequestSchema.parse(input);
    const { episodeId, ...body } = payload;
    const response = await api.put<unknown>(`/episodes/${episodeId}/progress`, body);
    parseEpisodeResponse(progressWriteResponseSchema, response.data, 'episode progress');
  },

  /** The caller's in-progress (not completed) episodes, most recent first. */
  async getContinueListening(params?: { limit?: number }): Promise<ContinueListeningEntry[]> {
    const response = await api.get<unknown>('/episodes/continue', params);
    return parseEpisodeResponse(continueListeningResponseSchema, response.data, 'continue listening').data;
  },
};
