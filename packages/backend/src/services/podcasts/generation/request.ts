/**
 * Asking for a generated episode — the one entry point the REST route
 * (`POST /api/podcasts/:id/episodes/generate`) and the MCP tool share.
 *
 * The caller has already proved the person owns the show
 * (`findPodcastForOwner`). This decides whether they may start another
 * generation, makes the show's profile on its first one (the brief, the
 * format and a cast from Kaana's catalogue), reserves the episode and queues
 * the job. It returns at once; the job runs in the ingest worker.
 */

import { uuidv7 } from '@oxy.so/db';
import {
  countActiveGenerations,
  countGenerationsSince,
  ensureGenerationProfile,
  findGenerationByIdempotencyKey,
  findGenerationProfile,
  insertGeneratedEpisode,
  updateGenerationBrief,
  type EpisodeGenerationRow,
  type GenerationProfileRow,
} from '../../../db/podcasts/generations';
import { findEpisodeById } from '../../../db/podcasts/episodes';
import type { EpisodeRow, PodcastRow } from '../../../db/podcasts/serialize';
import type { GenerationFormat } from '../../../db/schema/podcastGeneration';
import { enqueueEpisodeGeneration } from '../../ingest/ingestQueue';
import { kaanaForAccount, type GenerationKaana } from './kaana';
import { castFromCatalogue } from './speech';

/** Generations one person may have running at once. */
export const MAX_ACTIVE_GENERATIONS = 3;
/** Generations one person may ask for in a UTC day. */
export const MAX_DAILY_GENERATIONS = 20;

export interface GenerateEpisodeInput {
  /** What this episode covers. Absent: the script chooses from the brief. */
  readonly topic?: string;
  /** The episode's name. Absent: the script names it. */
  readonly title?: string;
  /** Source material to work from. */
  readonly notes?: string;
  /** What the show is about. Required on a show's first generated episode; replaces the brief after. */
  readonly brief?: string;
  /** Only on a show's first generated episode: it decides the cast. */
  readonly format?: GenerationFormat;
  /** Asking again with the same key answers the first request instead of starting another. */
  readonly idempotencyKey?: string;
}

/**
 * Runs `write` with the Oxy task that lets the finished audio become the
 * owner's own file, or with `null` where the caller has no session to create
 * one from (an MCP connection): the episode then keeps Syra's copy only.
 */
export type FileTaskRunner = <T>(
  episodeId: string,
  write: (oxyTaskId: string | null) => Promise<T>,
) => Promise<T>;

export type GenerationRefusal = {
  readonly ok: false;
  readonly status: 400 | 409 | 429 | 503;
  readonly code:
    | 'not_generatable'
    | 'brief_required'
    | 'too_many_running'
    | 'daily_limit'
    | 'speech_unavailable'
    | 'idempotency_conflict';
  readonly message: string;
};

export type GenerationRequestResult =
  | {
      readonly ok: true;
      readonly episode: EpisodeRow;
      readonly generation: EpisodeGenerationRow;
      /** `true` when the idempotency key named a generation already started. */
      readonly replayed: boolean;
    }
  | GenerationRefusal;

const refuse = (
  status: GenerationRefusal['status'],
  code: GenerationRefusal['code'],
  message: string,
): GenerationRefusal => ({ ok: false, status, code, message });

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface GenerationRequestDeps {
  kaanaFor(accountId: string): Promise<GenerationKaana>;
  enqueue(episodeId: string): Promise<void>;
}

const DEFAULT_DEPS: GenerationRequestDeps = {
  kaanaFor: kaanaForAccount,
  enqueue: enqueueEpisodeGeneration,
};

async function profileFor(
  show: PodcastRow,
  requesterId: string,
  input: GenerateEpisodeInput,
  deps: GenerationRequestDeps,
): Promise<GenerationProfileRow | GenerationRefusal> {
  const existing = await findGenerationProfile(show.id);
  const brief = input.brief?.trim();
  if (existing) {
    if (!brief || brief === existing.brief) return existing;
    return (await updateGenerationBrief(show.id, brief)) ?? existing;
  }

  const premise = brief || show.description?.trim();
  if (!premise) {
    return refuse(
      400,
      'brief_required',
      'Say what this show is about (a brief) to generate its first episode.',
    );
  }
  const format = input.format ?? 'podcast';
  const kaana = await deps.kaanaFor(requesterId);
  try {
    const cast = castFromCatalogue(await kaana.models.list(), format);
    if (!cast) {
      return refuse(
        503,
        'speech_unavailable',
        'No voices are available for generated episodes right now.',
      );
    }
    return await ensureGenerationProfile({
      podcastId: show.id,
      brief: premise,
      format,
      speechModel: cast.speechModel,
      speakers: cast.speakers,
    });
  } finally {
    kaana.dispose();
  }
}

export async function requestEpisodeGeneration(input: {
  readonly show: PodcastRow;
  readonly requesterId: string;
  readonly request: GenerateEpisodeInput;
  readonly fileTask: FileTaskRunner;
  readonly now?: Date;
  readonly deps?: GenerationRequestDeps;
}): Promise<GenerationRequestResult> {
  const { show, requesterId, request } = input;
  const deps = input.deps ?? DEFAULT_DEPS;
  const replay = await replayed(requesterId, show.id, request.idempotencyKey);
  if (replay) return replay;
  if (show.source !== 'syra' || show.status === 'removed') {
    return refuse(
      409,
      'not_generatable',
      'Episodes can only be generated for a show hosted on Syra.',
    );
  }
  if ((await countActiveGenerations(requesterId)) >= MAX_ACTIVE_GENERATIONS) {
    return refuse(
      429,
      'too_many_running',
      `You already have ${MAX_ACTIVE_GENERATIONS} episodes being generated. Wait for one to finish.`,
    );
  }
  const since = startOfUtcDay(input.now ?? new Date());
  if ((await countGenerationsSince(requesterId, since)) >= MAX_DAILY_GENERATIONS) {
    return refuse(429, 'daily_limit', `You can generate ${MAX_DAILY_GENERATIONS} episodes a day.`);
  }

  const profile = await profileFor(show, requesterId, request, deps);
  if ('ok' in profile) return profile;

  const episodeId = uuidv7();
  const created = await input.fileTask(episodeId, (oxyTaskId) =>
    insertGeneratedEpisode({
      episodeId,
      show,
      requestedByOxyUserId: requesterId,
      topic: request.topic?.trim() || null,
      requestedTitle: request.title?.trim() || null,
      notes: request.notes?.trim() || null,
      oxyTaskId,
      idempotencyKey: request.idempotencyKey ?? null,
      persons: [],
    }),
  );
  await deps.enqueue(episodeId);
  return { ok: true, replayed: false, ...created };
}

async function replayed(
  requesterId: string,
  podcastId: string,
  idempotencyKey: string | undefined,
): Promise<GenerationRequestResult | null> {
  if (idempotencyKey === undefined) return null;
  const generation = await findGenerationByIdempotencyKey(requesterId, idempotencyKey);
  if (!generation) return null;
  const found = await findEpisodeById(generation.episodeId);
  if (!found || generation.podcastId !== podcastId) {
    return refuse(
      409,
      'idempotency_conflict',
      'That idempotency key was used for another request.',
    );
  }
  return { ok: true, replayed: true, episode: found.episode, generation };
}
