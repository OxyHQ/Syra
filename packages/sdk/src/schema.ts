import { z } from 'zod';
import {
  EPISODE_STATUSES,
  PODCAST_VISIBILITIES,
  type CoverArtSizes,
  type CoverArtVariant,
  type EpisodeAudioSource,
  type EpisodeDeleted,
  type EpisodeDraft,
  type EpisodeStatus,
  type EpisodeStream,
  type EpisodeSummary,
  type PodcastDeleted,
  type PodcastSubscription,
  type PodcastSummary,
  type PodcastVisibility,
  type TrackSummary,
  type UploadedImage,
} from './types';

/**
 * The public Syra API response shapes as Zod schemas, for SERVER-side consumers
 * that want to hold a Syra response to the same contract this SDK does — Syra's
 * own backend tests assert their routes answer exactly what these accept.
 *
 * Served only from `@syra.fm/sdk/schemas`, never from the client or live-rooms
 * entries: an app that ships this SDK to a browser should not ship Zod for it.
 * The client checks the same shapes with `./responses`, and
 * `responses.parity.test.ts` runs both over one set of fixtures.
 *
 * Each schema documents nothing of its own — the field docs are on the types in
 * `./types`, and the `Same<…>` lines below fail the build when a schema and its
 * type disagree.
 */

export const coverArtVariantSchema = z.object({
  id: z.string().optional(),
  url: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  fileId: z.string().optional(),
  variant: z.string().optional(),
});

export const coverArtSizesSchema = z.object({
  small: coverArtVariantSchema.optional(),
  medium: coverArtVariantSchema.optional(),
  large: coverArtVariantSchema.optional(),
  xlarge: coverArtVariantSchema.optional(),
  xxlarge: coverArtVariantSchema.optional(),
  original: coverArtVariantSchema.optional(),
});

export const trackSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  artistId: z.string().optional(),
  artistName: z.string(),
  albumId: z.string().optional(),
  albumName: z.string().optional(),
  duration: z.number(),
  coverArt: z.string().optional(),
  coverArtSizes: coverArtSizesSchema.optional(),
  previewAvailable: z.boolean().optional(),
});

export const podcastVisibilitySchema = z.enum(PODCAST_VISIBILITIES);

export const podcastSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  author: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  imageSizes: coverArtSizesSchema.optional(),
  imageSourceUrl: z.string().optional(),
  visibility: podcastVisibilitySchema.optional(),
  aiGenerated: z.boolean().optional(),
});

export const podcastSubscriptionSchema = z.object({
  podcast: podcastSummarySchema,
  lastEpisodeAt: z.string().optional(),
});

export const episodeAudioSourceSchema = z.object({
  url: z.string(),
  format: z.string().optional(),
  bitrate: z.number().optional(),
  duration: z.number().optional(),
});

export const episodeStatusSchema = z.enum(EPISODE_STATUSES);

export const episodeSummarySchema = z.object({
  id: z.string(),
  podcastId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  enclosureUrl: z.string().optional(),
  enclosureType: z.string().optional(),
  enclosureLength: z.number().optional(),
  audioSource: episodeAudioSourceSchema.optional(),
  duration: z.number().optional(),
  pubDate: z.string().optional(),
  season: z.number().optional(),
  episodeNumber: z.number().optional(),
  status: episodeStatusSchema.optional(),
  aiGenerated: z.boolean().optional(),
  image: z.string().optional(),
  imageSizes: coverArtSizesSchema.optional(),
  imageSourceUrl: z.string().optional(),
});

export const episodeDraftSchema = z.object({
  episodeId: z.string(),
  ingestTicket: z.string(),
  expiresAt: z.string(),
});

export const podcastDeletedSchema = z.object({
  id: z.string(),
  episodesDeleted: z.number(),
  objectsDeleted: z.number(),
});

export const episodeDeletedSchema = z.object({
  id: z.string(),
  podcastId: z.string(),
  objectsDeleted: z.number(),
});

export const episodeStreamSchema = z.object({
  url: z.string(),
  type: z.string(),
  expiresAt: z.string().optional(),
});

export const uploadedImageSchema = z.object({
  id: z.string(),
  fileId: z.string().optional(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
});

/** `true` only when `A` and `B` are assignable both ways. */
export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type SchemaMatchesType = [
  Assert<Same<z.output<typeof coverArtVariantSchema>, CoverArtVariant>>,
  Assert<Same<z.output<typeof coverArtSizesSchema>, CoverArtSizes>>,
  Assert<Same<z.output<typeof trackSummarySchema>, TrackSummary>>,
  Assert<Same<z.output<typeof podcastVisibilitySchema>, PodcastVisibility>>,
  Assert<Same<z.output<typeof podcastSummarySchema>, PodcastSummary>>,
  Assert<Same<z.output<typeof podcastSubscriptionSchema>, PodcastSubscription>>,
  Assert<Same<z.output<typeof episodeAudioSourceSchema>, EpisodeAudioSource>>,
  Assert<Same<z.output<typeof episodeStatusSchema>, EpisodeStatus>>,
  Assert<Same<z.output<typeof episodeSummarySchema>, EpisodeSummary>>,
  Assert<Same<z.output<typeof episodeDraftSchema>, EpisodeDraft>>,
  Assert<Same<z.output<typeof podcastDeletedSchema>, PodcastDeleted>>,
  Assert<Same<z.output<typeof episodeDeletedSchema>, EpisodeDeleted>>,
  Assert<Same<z.output<typeof episodeStreamSchema>, EpisodeStream>>,
  Assert<Same<z.output<typeof uploadedImageSchema>, UploadedImage>>,
];
