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

/**
 * A person CREDIT stored inline on a show/episode (Hosts & Guests). Mirrors
 * `episodePersonSchema` in episode.ts — defined here (not imported) to avoid a
 * circular module dependency between podcast.ts and episode.ts. `linkedOxyUserId`
 * is set for creator-added credits (Oxy users); RSS credits carry `img`/`href`.
 */
export const podcastPersonSchema = z.object({
  name: z.string(),
  role: z.string().optional(),
  group: z.string().optional(),
  img: z.string().optional(),
  href: z.string().optional(),
  linkedOxyUserId: z.string().optional(),
});
export type PodcastPerson = z.infer<typeof podcastPersonSchema>;

/**
 * A RESOLVED person returned on show/episode detail: the global `Person` row +
 * the linked Oxy identity (avatar file id + displayName) when `linkedOxyUserId`
 * is set, otherwise the external `img`/`href` from the RSS credit.
 */
export const resolvedPersonSchema = z.object({
  personId: z.string(),
  name: z.string(),
  role: z.string().optional(),
  group: z.string().optional(),
  href: z.string().optional(),
  /** External avatar URL (RSS persons only; absent for Oxy-linked). */
  img: z.string().optional(),
  linkedOxyUserId: z.string().optional(),
  linkedArtistId: z.string().optional(),
  /** Oxy avatar file id (resolve via the media resolver) when Oxy-linked. */
  oxyAvatar: z.string().optional(),
  /** Oxy `name.displayName` when Oxy-linked. */
  displayName: z.string().optional(),
  /** Oxy handle — the frontend routes to `/u/[username]` when Oxy-linked. */
  username: z.string().optional(),
});
export type ResolvedPerson = z.infer<typeof resolvedPersonSchema>;

export const podcastSchema = timestampsSchema.extend({
  id: z.string(),
  _id: z.string().optional(),
  // Identity
  title: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  // Cover art: `image` is the Syra image id (re-hosted, resolved via /api/images/:id,
  // mirrors Artist); `imageSizes` is the multi-resolution variant set; `primaryColor`/
  // `secondaryColor` are extracted from the cover (gradient source). `imageSourceUrl`
  // keeps the original external artwork URL as a fallback only.
  image: z.string().optional(),
  imageSizes: catalogImageSizesSchema.optional(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  imageSourceUrl: z.string().optional(),
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
  /** Shallow (directory-only) doc awaiting a background deep feed import. */
  needsDeepImport: z.boolean().optional(),
  // Signals
  popularity: z.number().optional(),
  subscriberCount: z.number().optional(),
  status: podcastStatusSchema,
  // Optional Podcasting 2.0
  funding: z.array(podcastFundingSchema).optional(),
  persons: z.array(podcastPersonSchema).optional(),
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
  /** Hosts & Guests as Oxy user ids (validated server-side; no free text). */
  hosts: z.array(z.string()).optional(),
  guests: z.array(z.string()).optional(),
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
