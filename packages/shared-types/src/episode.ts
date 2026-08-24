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
 * user is authenticated here and is the one who decides the title, the artwork,
 * the credits and the disclosure. The ticket holder can afterwards set only what
 * it learns by making the audio — see `services/podcasts/ingestToken.ts`.
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
 * Every field here is something a worker knows because it produced the audio.
 * Nothing that identifies, publishes or attributes the episode is reachable:
 * title, artwork, `explicit`, `episodeType`, credits, `status`, `aiGenerated`
 * and every storage column were fixed by the authenticated user at draft time.
 *
 * Numbers arrive as multipart strings, so each one is coerced and then
 * validated — a coercion without a validation is how `NaN` reaches a column.
 */
export const ingestEpisodeAudioRequestSchema = z.object({
  duration: z.coerce.number().nonnegative().optional(),
  season: z.coerce.number().int().nonnegative().optional(),
  episodeNumber: z.coerce.number().int().nonnegative().optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
});
export type IngestEpisodeAudioRequest = z.infer<typeof ingestEpisodeAudioRequestSchema>;

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
