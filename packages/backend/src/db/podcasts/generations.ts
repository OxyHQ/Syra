/**
 * Reads and writes for generated episodes (`schema/podcastGeneration.ts`).
 *
 * Ownership is never decided here: every caller has already loaded the show
 * through `findPodcastForOwner`, or is the worker running a job the owner
 * queued. What this module guarantees is that a generated episode is one
 * `episodes` row and one `episode_generations` row, written together.
 */

import { and, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import type { EpisodeGeneration, EpisodePerson } from '@syra/shared-types';
import { getDb } from '../postgres';
import { episodes } from '../schema/podcasts';
import {
  ACTIVE_GENERATION_STATUSES,
  episodeGenerations,
  podcastGenerationProfiles,
  type GenerationSegment,
  type GenerationStatus,
} from '../schema/podcastGeneration';
import { insertEpisode } from './episodes';
import type { EpisodeRow, PodcastRow } from './serialize';

export type GenerationProfileRow = typeof podcastGenerationProfiles.$inferSelect;
export type EpisodeGenerationRow = typeof episodeGenerations.$inferSelect;

export async function findGenerationProfile(
  podcastId: string,
): Promise<GenerationProfileRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(podcastGenerationProfiles)
    .where(eq(podcastGenerationProfiles.podcastId, podcastId))
    .limit(1);
  return row;
}

/**
 * Store a show's profile, or keep the one already there. Two first requests
 * racing for one show both end up with the same cast: whichever landed first.
 */
export async function ensureGenerationProfile(
  values: typeof podcastGenerationProfiles.$inferInsert,
): Promise<GenerationProfileRow> {
  await getDb().insert(podcastGenerationProfiles).values(values).onConflictDoNothing();
  const row = await findGenerationProfile(values.podcastId);
  if (!row) throw new Error(`ensureGenerationProfile: profile for ${values.podcastId} vanished`);
  return row;
}

/** The owner restating what the show is about. The cast stays: it is the show's voice. */
export async function updateGenerationBrief(
  podcastId: string,
  brief: string,
): Promise<GenerationProfileRow | undefined> {
  const [row] = await getDb()
    .update(podcastGenerationProfiles)
    .set({ brief })
    .where(eq(podcastGenerationProfiles.podcastId, podcastId))
    .returning();
  return row;
}

/** How many of this person's generations are still running. */
export async function countActiveGenerations(oxyUserId: string): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(episodeGenerations)
    .where(
      and(
        eq(episodeGenerations.requestedByOxyUserId, oxyUserId),
        inArray(episodeGenerations.status, [...ACTIVE_GENERATION_STATUSES]),
      ),
    );
  return row?.count ?? 0;
}

/** How many generations this person asked for since `since`. */
export async function countGenerationsSince(oxyUserId: string, since: Date): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(episodeGenerations)
    .where(
      and(
        eq(episodeGenerations.requestedByOxyUserId, oxyUserId),
        gte(episodeGenerations.createdAt, since),
      ),
    );
  return row?.count ?? 0;
}

export interface GeneratedEpisodeDraft {
  readonly episodeId: string;
  readonly show: PodcastRow;
  readonly requestedByOxyUserId: string;
  readonly topic: string | null;
  readonly requestedTitle: string | null;
  readonly notes: string | null;
  /** The Oxy task that lets the finished audio become the owner's own file, when there is one. */
  readonly oxyTaskId: string | null;
  /** The caller's key for this request, when it sent one. */
  readonly idempotencyKey: string | null;
  readonly persons: readonly EpisodePerson[];
}

/**
 * Reserve the episode and its job in one transaction.
 *
 * The episode number is the show's highest plus one, taken under a transaction
 * advisory lock on the show, so two requests a second apart cannot both be
 * episode 4. The row starts `processing` with no audio: nobody but the owner
 * sees it until ingest makes it `ready`.
 */
export async function insertGeneratedEpisode(
  draft: GeneratedEpisodeDraft,
): Promise<{ episode: EpisodeRow; generation: EpisodeGenerationRow }> {
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`episode-number:${draft.show.id}`}))`,
    );
    const [last] = await tx
      .select({ number: sql<number | null>`max(${episodes.episodeNumber})` })
      .from(episodes)
      .where(eq(episodes.podcastId, draft.show.id));
    const episodeNumber = (last?.number ?? 0) + 1;

    const episode = await insertEpisode(
      {
        id: draft.episodeId,
        oxyTaskId: draft.oxyTaskId,
        podcastId: draft.show.id,
        podcastTitle: draft.show.title,
        // The owner's name for it, or a placeholder the script replaces.
        title: draft.requestedTitle ?? `Episode ${episodeNumber}`,
        guid: draft.episodeId,
        duration: 0,
        pubDate: new Date(),
        episodeNumber,
        episodeType: 'full',
        explicit: false,
        aiGenerated: true,
        source: 'syra',
        // Derived from the id, so knowable now; `ingestEpisode` reads it as
        // "this episode has source audio" once the file is stored.
        audioSourceUrl: `/api/podcasts/episodes/${draft.episodeId}/audio`,
        status: 'processing',
      },
      { persons: [...draft.persons] },
      { recordOnShow: true },
      tx,
    );

    const [generation] = await tx
      .insert(episodeGenerations)
      .values({
        episodeId: draft.episodeId,
        podcastId: draft.show.id,
        requestedByOxyUserId: draft.requestedByOxyUserId,
        topic: draft.topic,
        requestedTitle: draft.requestedTitle,
        notes: draft.notes,
        idempotencyKey: draft.idempotencyKey,
      })
      .returning();
    if (!generation) throw new Error('insertGeneratedEpisode: insert returned no row');
    return { episode, generation };
  });
}

export async function findGeneration(episodeId: string): Promise<EpisodeGenerationRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(episodeGenerations)
    .where(eq(episodeGenerations.episodeId, episodeId))
    .limit(1);
  return row;
}

/** The generation this person already started with `idempotencyKey`, if any. */
export async function findGenerationByIdempotencyKey(
  requestedByOxyUserId: string,
  idempotencyKey: string,
): Promise<EpisodeGenerationRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(episodeGenerations)
    .where(
      and(
        eq(episodeGenerations.requestedByOxyUserId, requestedByOxyUserId),
        eq(episodeGenerations.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return row;
}

/** A show's generations, newest first: what Studio and the MCP status tool list. */
export async function listGenerationsForPodcast(
  podcastId: string,
  limit: number,
): Promise<EpisodeGenerationRow[]> {
  return getDb()
    .select()
    .from(episodeGenerations)
    .where(eq(episodeGenerations.podcastId, podcastId))
    .orderBy(desc(episodeGenerations.createdAt))
    .limit(limit);
}

export type GenerationPatch = Partial<{
  status: GenerationStatus;
  progress: number;
  topic: string | null;
  segments: GenerationSegment[];
  recap: string | null;
  error: string | null;
}>;

export async function updateGeneration(
  episodeId: string,
  patch: GenerationPatch,
): Promise<EpisodeGenerationRow | undefined> {
  const [row] = await getDb()
    .update(episodeGenerations)
    .set(patch)
    .where(eq(episodeGenerations.episodeId, episodeId))
    .returning();
  return row;
}

export interface PriorGeneratedEpisode {
  readonly episodeNumber: number;
  readonly topic: string | null;
  readonly recap: string | null;
}

/**
 * The show's memory for episode `episodeNumber`: the earlier generated
 * episodes, OLDEST first, at most `limit` of them (the newest ones).
 *
 * A failed run said nothing to a listener, so it is left out. One still
 * running is kept: it has already claimed its subject, which is what stops two
 * episodes queued a minute apart covering the same thing.
 */
export async function priorGeneratedEpisodes(
  podcastId: string,
  episodeNumber: number,
  limit: number,
): Promise<PriorGeneratedEpisode[]> {
  const rows = await getDb()
    .select({
      episodeNumber: episodes.episodeNumber,
      topic: episodeGenerations.topic,
      recap: episodeGenerations.recap,
    })
    .from(episodeGenerations)
    .innerJoin(episodes, eq(episodes.id, episodeGenerations.episodeId))
    .where(
      and(
        eq(episodeGenerations.podcastId, podcastId),
        ne(episodeGenerations.status, 'failed'),
        lt(episodes.episodeNumber, episodeNumber),
      ),
    )
    .orderBy(desc(episodes.episodeNumber))
    .limit(limit);
  return rows.filter((row): row is PriorGeneratedEpisode => row.episodeNumber !== null).reverse();
}

/** The job as its owner sees it: named columns only, never who asked or their notes. */
export function toEpisodeGenerationDto(row: EpisodeGenerationRow): EpisodeGeneration {
  return {
    episodeId: row.episodeId,
    podcastId: row.podcastId,
    status: row.status,
    progress: row.progress,
    topic: row.topic,
    segments: row.segments,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
