/**
 * Generated episodes: a creator (or an agent acting for them) asks Syra to
 * write and voice an episode of a show they own, and it becomes an ordinary
 * hosted episode of that show — in its RSS feed, playable in the app and in
 * Studio. See `docs/podcast-generation.md`.
 *
 * Two tables, and neither holds audio. The finished file is the episode's own
 * source audio, stored and served exactly like an uploaded one
 * (`services/oxyFiles/audioStorage.ts`, `services/podcasts/ingestEpisode.ts`).
 *
 * - `podcast_generation_profiles` — what a show is about and who speaks in it,
 *   one row per show that has had an episode generated. The cast is chosen once,
 *   from the voices Kaana publishes for one speech model, so every episode of a
 *   show is spoken by the same people.
 * - `episode_generations` — the job and its memory, one row per generated
 *   episode: what it covers (the show's long memory, one line per episode), its
 *   recap (the short, detailed memory), its script and its progress.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, inList, updatedAt } from '@oxy.so/db';
import { episodes, podcasts } from './podcasts';

/** How an episode is written: who talks and how. Each format has its own cast. */
export const GENERATION_FORMATS = ['podcast', 'news', 'debate', 'interview', 'explainer'] as const;
export type GenerationFormat = (typeof GENERATION_FORMATS)[number];

export const GENERATION_SPEAKER_ROLES = ['host', 'co-host', 'guest', 'narrator'] as const;
export type GenerationSpeakerRole = (typeof GENERATION_SPEAKER_ROLES)[number];

/**
 * The steps an episode goes through. `completed` means the audio is the
 * episode's: Syra's own ingest decides when it is `ready` to play.
 */
export const GENERATION_STATUSES = [
  'queued',
  'writing',
  'recording',
  'assembling',
  'publishing',
  'completed',
  'failed',
] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

/** Still running: what the per-person concurrency cap counts. */
export const ACTIVE_GENERATION_STATUSES: readonly GenerationStatus[] = [
  'queued',
  'writing',
  'recording',
  'assembling',
  'publishing',
];

/** One voice of a show's cast. `name` is what the script calls them on air. */
export interface GenerationSpeaker {
  name: string;
  voiceId: string;
  role: GenerationSpeakerRole;
}

/** One spoken line of a script. `renderFailed` marks a line that could not be voiced. */
export interface GenerationSegment {
  speaker: string;
  text: string;
  renderFailed?: boolean;
}

export const podcastGenerationProfiles = pgTable(
  'podcast_generation_profiles',
  {
    podcastId: text()
      .primaryKey()
      .references(() => podcasts.id, { onDelete: 'cascade' }),
    /** The show's standing premise, in its owner's words. Every episode's subject comes from it. */
    brief: text().notNull(),
    format: text({ enum: GENERATION_FORMATS }).notNull().default('podcast'),
    /**
     * The Kaana speech model the cast's voices belong to. Chosen from Kaana's
     * catalogue when the profile is made — a voice is a voice OF a model — and
     * stored, never configured.
     */
    speechModel: text().notNull(),
    speakers: jsonb().$type<GenerationSpeaker[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'podcast_generation_profiles_format_check',
      sql`${t.format} in (${sql.raw(inList(GENERATION_FORMATS))})`,
    ),
  ],
);

export const episodeGenerations = pgTable(
  'episode_generations',
  {
    episodeId: text()
      .primaryKey()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    podcastId: text()
      .notNull()
      .references(() => podcasts.id, { onDelete: 'cascade' }),
    /** The Oxy account that asked. No foreign key — Oxy owns identity. */
    requestedByOxyUserId: text().notNull(),
    /**
     * What this episode covers: the one the owner asked for, or the one the
     * script chose. NULL until one of the two says. It is the show's memory —
     * every later episode is told these, so it does not repeat one.
     */
    topic: text(),
    /** The name the owner asked for. NULL lets the script name the episode. */
    requestedTitle: text(),
    /** Source material the owner supplied. */
    notes: text(),
    status: text({ enum: GENERATION_STATUSES }).notNull().default('queued'),
    progress: integer().notNull().default(0),
    segments: jsonb().$type<GenerationSegment[]>().notNull().default([]),
    /** A few sentences the NEXT episodes read to remember what this one said. */
    recap: text(),
    /** What went wrong, in words the owner can read. Never an upstream message. */
    error: text(),
    /**
     * The caller's key for this request (the MCP `generate-episode` tool's
     * `idempotencyKey`): asking again with it answers this generation instead
     * of starting, and paying for, another.
     */
    idempotencyKey: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'episode_generations_status_check',
      sql`${t.status} in (${sql.raw(inList(GENERATION_STATUSES))})`,
    ),
    check('episode_generations_progress_check', sql`${t.progress} between 0 and 100`),
    // A show's memory: its earlier episodes, newest first.
    index('episode_generations_podcast_created_at_idx').on(t.podcastId, t.createdAt.desc()),
    uniqueIndex('episode_generations_requester_idempotency_key')
      .on(t.requestedByOxyUserId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    // The per-person caps: how many are running, and how many today.
    index('episode_generations_requester_created_at_idx').on(
      t.requestedByOxyUserId,
      t.createdAt.desc(),
    ),
  ],
);
