import { z } from 'zod';
import { timestampsSchema } from './common';
import { catalogImageSizesSchema } from './track';

/** Origin of a show: an external RSS feed mirrored into Syra, or a show hosted on Syra. */
export const podcastSourceSchema = z.enum(['rss', 'syra']);
export type PodcastSource = z.infer<typeof podcastSourceSchema>;

/** Provider that contributed data to a show (the feed itself or a discovery directory). */
export const podcastProvenanceProviderSchema = z.enum(['rss', 'syra', 'podcastindex', 'apple']);
export type PodcastProvenanceProvider = z.infer<typeof podcastProvenanceProviderSchema>;

export const podcastSourceProvenanceSchema = z.object({
  provider: podcastProvenanceProviderSchema,
  externalId: z.string(),
  importedAt: z.string(),
  fields: z.array(z.string()),
});
export type PodcastSourceProvenance = z.infer<typeof podcastSourceProvenanceSchema>;

export const podcastTypeSchema = z.enum(['episodic', 'serial']);
export type PodcastType = z.infer<typeof podcastTypeSchema>;

export const podcastStatusSchema = z.enum(['active', 'unavailable', 'removed']);
export type PodcastStatus = z.infer<typeof podcastStatusSchema>;

/** Podcasting 2.0 `<podcast:funding>` tag. */
export const podcastFundingSchema = z.object({
  url: z.string(),
  message: z.string().optional(),
});
export type PodcastFunding = z.infer<typeof podcastFundingSchema>;

export const podcastSchema = timestampsSchema.extend({
  id: z.string(),
  _id: z.string().optional(),
  // Identity
  title: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  image: z.string().optional(),
  imageSizes: catalogImageSizesSchema.optional(),
  language: z.string().optional(),
  categories: z.array(z.string()).optional(),
  explicit: z.boolean(),
  link: z.string().optional(),
  type: podcastTypeSchema,
  // Feed identity
  feedUrl: z.string().optional(),
  podcastGuid: z.string().optional(),
  podcastIndexId: z.number().optional(),
  appleCollectionId: z.number().optional(),
  // Origin
  source: podcastSourceSchema,
  // Linking
  ownerOxyUserId: z.string().optional(),
  claimable: z.boolean().optional(),
  claimedByOxyUserId: z.string().optional(),
  linkedArtistId: z.string().optional(),
  // Refresh / HTTP conditional-GET cache
  lastRefreshedAt: z.string().optional(),
  refreshIntervalMin: z.number(),
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  episodeCount: z.number(),
  lastEpisodeAt: z.string().optional(),
  // Signals
  popularity: z.number().optional(),
  subscriberCount: z.number().optional(),
  status: podcastStatusSchema,
  // Optional Podcasting 2.0
  funding: z.array(podcastFundingSchema).optional(),
  value: z.record(z.string(), z.unknown()).optional(),
  // Provenance
  sources: z.array(podcastSourceProvenanceSchema).optional(),
});
export type Podcast = z.infer<typeof podcastSchema>;

export const podcastWithContextSchema = podcastSchema.extend({
  isSubscribed: z.boolean().optional(),
});
export type PodcastWithContext = z.infer<typeof podcastWithContextSchema>;

export const createPodcastRequestSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  image: z.string().optional(),
  language: z.string().optional(),
  categories: z.array(z.string()).optional(),
  explicit: z.boolean().optional(),
  link: z.string().optional(),
  type: podcastTypeSchema.optional(),
});
export type CreatePodcastRequest = z.infer<typeof createPodcastRequestSchema>;

export const updatePodcastRequestSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  image: z.string().optional(),
  language: z.string().optional(),
  categories: z.array(z.string()).optional(),
  explicit: z.boolean().optional(),
  link: z.string().optional(),
  type: podcastTypeSchema.optional(),
});
export type UpdatePodcastRequest = z.infer<typeof updatePodcastRequestSchema>;

export const importFeedRequestSchema = z.object({
  feedUrl: z.string(),
});
export type ImportFeedRequest = z.infer<typeof importFeedRequestSchema>;
