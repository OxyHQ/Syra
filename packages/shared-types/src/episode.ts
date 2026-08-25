import { z } from 'zod';
import { timestampsSchema } from './common';
import {
  audioSourceSchema,
  hlsRenditionSchema,
  catalogImageSizesSchema,
} from './track';
import { podcastSourceSchema } from './podcast';

export const episodeTypeSchema = z.enum(['full', 'trailer', 'bonus']);
export type EpisodeType = z.infer<typeof episodeTypeSchema>;

export const episodeStatusSchema = z.enum(['ready', 'processing', 'failed', 'unavailable']);
export type EpisodeStatus = z.infer<typeof episodeStatusSchema>;

/**
 * Hybrid-audio cache state for an RSS episode. `none` streams from the origin
 * enclosure, `cached` from a copied S3 object, `hls` from a transcoded ladder.
 */
export const episodeCacheStatusSchema = z.enum(['none', 'cached', 'hls']);
export type EpisodeCacheStatus = z.infer<typeof episodeCacheStatusSchema>;

export const episodeCacheSchema = z.object({
  status: episodeCacheStatusSchema,
  s3Key: z.string().optional(),
  hlsMasterKey: z.string().optional(),
  cachedAt: z.string().optional(),
});
export type EpisodeCache = z.infer<typeof episodeCacheSchema>;

/** Podcasting 2.0 `<podcast:chapters>` (PSC/JSON). */
export const episodeChaptersSchema = z.object({
  url: z.string(),
  type: z.string(),
});
export type EpisodeChapters = z.infer<typeof episodeChaptersSchema>;

/** Podcasting 2.0 `<podcast:transcript>`. */
export const episodeTranscriptSchema = z.object({
  url: z.string(),
  type: z.string(),
  language: z.string().optional(),
});
export type EpisodeTranscript = z.infer<typeof episodeTranscriptSchema>;

/**
 * Podcasting 2.0 `<podcast:person>` (host/guest credit, inline on the episode).
 * `linkedOxyUserId` is set for creator-added credits (Oxy users).
 */
export const episodePersonSchema = z.object({
  name: z.string(),
  role: z.string().optional(),
  group: z.string().optional(),
  img: z.string().optional(),
  href: z.string().optional(),
  linkedOxyUserId: z.string().optional(),
});
export type EpisodePerson = z.infer<typeof episodePersonSchema>;

export const episodeSchema = timestampsSchema.extend({
  id: z.string(),
  podcastId: z.string(),
  podcastTitle: z.string(),
  title: z.string(),
  description: z.string().optional(),
  summary: z.string().optional(),
  guid: z.string(),
  // Origin enclosure (RSS); absent for Syra-hosted episodes
  enclosureUrl: z.string().optional(),
  enclosureType: z.string().optional(),
  enclosureLength: z.number().optional(),
  duration: z.number(),
  pubDate: z.string(),
  season: z.number().optional(),
  episodeNumber: z.number().optional(),
  episodeType: episodeTypeSchema,
  // Episode-specific cover art (only when the episode carries its own artwork;
  // otherwise it inherits the show's). `image` is the re-hosted Syra image id;
  // `primaryColor`/`secondaryColor` come from that art; `imageSourceUrl` is the
  // original external URL kept as a fallback only.
  image: z.string().optional(),
  imageSizes: catalogImageSizesSchema.optional(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  imageSourceUrl: z.string().optional(),
  explicit: z.boolean(),
  // Podcasting 2.0
  chapters: episodeChaptersSchema.optional(),
  transcripts: z.array(episodeTranscriptSchema).optional(),
  persons: z.array(episodePersonSchema).optional(),
  // Hybrid audio
  source: podcastSourceSchema,
  cache: episodeCacheSchema.optional(),
  audioSource: audioSourceSchema.optional(),
  hls: z.array(hlsRenditionSchema).optional(),
  hlsMasterKey: z.string().optional(),
  // Signals
  playCount: z.number().optional(),
  popularity: z.number().optional(),
  status: episodeStatusSchema,
  /** Disclosure: this episode's content was machine-generated. Per episode, not inherited. */
  aiGenerated: z.boolean(),
});
export type Episode = z.infer<typeof episodeSchema>;

export const episodeWithContextSchema = episodeSchema.extend({
  progressSec: z.number().optional(),
  completed: z.boolean().optional(),
});
export type EpisodeWithContext = z.infer<typeof episodeWithContextSchema>;

export const createEpisodeRequestSchema = z.object({
  podcastId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  summary: z.string().optional(),
  pubDate: z.string().optional(),
  season: z.number().optional(),
  episodeNumber: z.number().optional(),
  episodeType: episodeTypeSchema.optional(),
  image: z.string().optional(),
  explicit: z.boolean().optional(),
  /** Hosts & Guests as Oxy user ids (validated server-side; no free text). */
  hosts: z.array(z.string()).optional(),
  guests: z.array(z.string()).optional(),
});
export type CreateEpisodeRequest = z.infer<typeof createEpisodeRequestSchema>;

/**
 * `POST /api/podcasts/:id/episodes/draft` — reserve an episode now, attach the
 * audio later.
 *
 * The same creator metadata `POST /:id/episodes` accepts, MINUS the audio: the
 * user is authenticated here and is the one who decides the artwork, the
 * credits and the disclosure. The ticket holder can afterwards set only what it
 * learns by making the audio — see `services/podcasts/ingestToken.ts`.
 *
 * ## `title` stays REQUIRED, now that the ingest may also set one
 *
 * The obvious follow-on is to drop it: a caller that knows the name will only
 * be known later is being made to invent one now. It is kept anyway, because
 * the two changes point in opposite directions and only one of them is safe.
 *
 * A required title means every episode has a name a HUMAN chose from the moment
 * it exists, and the ingest can only improve on it. Drop the requirement and
 * there is no such floor: an episode drafted and never redeemed — the ticket
 * expired, the generation failed, the worker crashed — has no name at all, and
 * `episodes.title` is `NOT NULL`, so the server would have to invent a
 * placeholder instead. That placeholder is strictly worse than the caller's,
 * because it is the same string for everyone and it survives into the public
 * feed on any ingest that omits a title.
 *
 * So the cost of keeping it is one line at a call site that already knows the
 * topic; the cost of relaxing it is an episode that nobody ever named. A
 * working title is not a burden — it is the fallback the whole "absent means
 * keep" rule in {@link ingestEpisodeAudioRequestSchema} depends on having.
 */
export const createEpisodeDraftRequestSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  summary: z.string().optional(),
  season: z.number().int().nonnegative().optional(),
  episodeNumber: z.number().int().nonnegative().optional(),
  episodeType: episodeTypeSchema.optional(),
  explicit: z.boolean().optional(),
  /** Disclosure, set by the authenticated user — never by the ticket holder. */
  aiGenerated: z.boolean().optional(),
  /** Hosts & Guests as Oxy user ids (validated server-side; no free text). */
  hosts: z.array(z.string()).optional(),
  guests: z.array(z.string()).optional(),
});
export type CreateEpisodeDraftRequest = z.infer<typeof createEpisodeDraftRequestSchema>;

/** What a draft hands back: the episode to fill, and the capability to fill it with. */
export const createEpisodeDraftResponseSchema = z.object({
  episodeId: z.string(),
  ingestTicket: z.string(),
  expiresAt: z.string(),
});
export type CreateEpisodeDraftResponse = z.infer<typeof createEpisodeDraftResponseSchema>;

/**
 * The multipart fields `POST /api/podcasts/episodes/:id/ingest` accepts beside
 * the audio — an ALLOWLIST, and the security boundary of the whole capability.
 *
 * Every field here is something a worker knows because it PRODUCED the audio,
 * and that is the test each one has to pass. Nothing that publishes or
 * attributes the episode is reachable: artwork, `explicit`, `episodeType`,
 * credits, `status` and `aiGenerated` are the authenticated user's own
 * declarations, and every storage column belongs to the server.
 *
 * ## Why `title` is here, and why that is not a widening of the capability
 *
 * A draft is written before any script exists, so its title can only ever
 * describe the topic that was REQUESTED. The name an episode deserves is a
 * property of its finished content, and the worker holding this ticket is the
 * only party that has read it — so refusing the title here did not protect the
 * episode's identity, it just guaranteed the identity was decided by whoever
 * knew least.
 *
 * The ticket is already authorised to attach the AUDIO to this episode, which
 * is the more consequential of the two by a wide margin: it decides what
 * listeners actually hear, and the title is the label on it. A capability that
 * may choose the contents may choose the name of the contents. It stays bound
 * to ONE episode, single-use, owner-checked at redemption and refused once the
 * episode has media — none of which this changes.
 *
 * `title` is validated exactly as the two authenticated doors validate it
 * (`createEpisodeDraft`, `uploadEpisode`): trimmed, and a blank result refused
 * rather than stored. The column is `NOT NULL` but not non-empty, so without
 * the `min(1)` an episode called nothing would reach the public feed. Absent
 * means KEEP WHAT THE DRAFT SAID — a worker with nothing better than the
 * placeholder must still be able to deliver the audio.
 *
 * Numbers arrive as multipart strings, so each one is coerced and then
 * validated — a coercion without a validation is how `NaN` reaches a column.
 */
export const ingestEpisodeAudioRequestSchema = z.object({
  title: z.string().trim().min(1).optional(),
  duration: z.coerce.number().nonnegative().optional(),
  season: z.coerce.number().int().nonnegative().optional(),
  episodeNumber: z.coerce.number().int().nonnegative().optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
});
export type IngestEpisodeAudioRequest = z.infer<typeof ingestEpisodeAudioRequestSchema>;

/**
 * `POST /api/podcasts/episodes/:id/ingest/abandon` — the other ending.
 *
 * A draft reserves an episode and hands out a ticket; the worker that holds it
 * either attaches audio or it does not. Only the first of those had a route, so
 * a pipeline that failed on its own side marked its OWN row failed, told Syra
 * nothing, and left the episode at `processing` with no audio — measured in
 * production on three episodes of one show, none of which had an object in S3
 * at all. This is the transition that closes it.
 *
 * ## `reason` is bounded, and it is for OPERATORS only
 *
 * It is the only free text a ticket holder may send, and unlike `title` it
 * describes a failure rather than the content — which means the string a worker
 * has closest to hand is an upstream provider's own error message. That must not
 * become a Syra surface, so `reason` is written to the API log and nowhere else:
 * no column, no DTO, no response body. `abandonEpisodeIngest`
 * (`controllers/podcastIngest.controller.ts`) is where that is enforced and
 * `routes/podcastIngest.test.ts` is where it is asserted.
 *
 * The 200-character bound is the part that holds regardless of the caller: a
 * stack trace, a JSON error envelope or a prompt echo does not fit in it, so the
 * worst case is a truncated sentence in a log line rather than an upstream
 * payload. Trimmed and refused blank on the same rule `title` follows, so a
 * whitespace-only reason is a 400 rather than an empty log field.
 */
export const abandonEpisodeIngestRequestSchema = z.object({
  reason: z.string().trim().min(1).max(200).optional(),
});
export type AbandonEpisodeIngestRequest = z.infer<typeof abandonEpisodeIngestRequestSchema>;

export const updateEpisodeRequestSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
  season: z.number().optional(),
  episodeNumber: z.number().optional(),
  episodeType: episodeTypeSchema.optional(),
  image: z.string().optional(),
  explicit: z.boolean().optional(),
});
export type UpdateEpisodeRequest = z.infer<typeof updateEpisodeRequestSchema>;
