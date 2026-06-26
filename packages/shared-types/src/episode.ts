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

/** Podcasting 2.0 `<podcast:person>` (host/guest credit, inline on the episode). */
export const episodePersonSchema = z.object({
  name: z.string(),
  role: z.string().optional(),
  group: z.string().optional(),
  img: z.string().optional(),
  href: z.string().optional(),
});
export type EpisodePerson = z.infer<typeof episodePersonSchema>;

export const episodeSchema = timestampsSchema.extend({
  id: z.string(),
  _id: z.string().optional(),
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
  image: z.string().optional(),
  imageSizes: catalogImageSizesSchema.optional(),
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
});
export type CreateEpisodeRequest = z.infer<typeof createEpisodeRequestSchema>;

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
