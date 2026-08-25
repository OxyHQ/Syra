import { z } from 'zod';

/**
 * Minimal, self-contained schemas for the public Syra API response shapes this
 * SDK consumes. Intentionally NOT shared with the Syra backend's internal
 * types — the SDK validates only the fields it returns, and tolerantly strips
 * everything else (Zod object schemas drop unknown keys by default), so the API
 * can evolve without breaking external consumers.
 */

/** A single artwork variant. The backend serializes `url` as `/api/images/:id`. */
export const coverArtVariantSchema = z.object({
  id: z.string().optional(),
  url: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
});
export type CoverArtVariant = z.infer<typeof coverArtVariantSchema>;

/** Named artwork variants keyed by size. */
export const coverArtSizesSchema = z.object({
  small: coverArtVariantSchema.optional(),
  medium: coverArtVariantSchema.optional(),
  large: coverArtVariantSchema.optional(),
  xlarge: coverArtVariantSchema.optional(),
  xxlarge: coverArtVariantSchema.optional(),
  original: coverArtVariantSchema.optional(),
});
export type CoverArtSizes = z.infer<typeof coverArtSizesSchema>;

/** Artwork size name. */
export type ArtworkSize = keyof CoverArtSizes;

/**
 * The summary view of a track returned by the public catalog endpoints — just
 * enough to render a song row and play its preview.
 */
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
export type TrackSummary = z.infer<typeof trackSummarySchema>;

/**
 * The summary view of a podcast SHOW returned by the public podcast endpoints
 * (`GET /api/podcasts/search`, `GET /api/podcasts/:id`) — just enough to render
 * a show card and deep-link into the Syra app.
 *
 * Artwork mirrors tracks: `image` is the re-hosted Syra image id (resolved via
 * `/api/images/:id`); `imageSizes` is the multi-resolution variant set (each
 * variant `url` is `/api/images/:id`); `imageSourceUrl` keeps the original
 * external artwork URL as an absolute fallback when re-hosting has not run yet.
 */
export const podcastVisibilitySchema = z.enum(['private', 'unlisted', 'public']);
export type PodcastVisibility = z.infer<typeof podcastVisibilitySchema>;

export const podcastSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  author: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  imageSizes: coverArtSizesSchema.optional(),
  imageSourceUrl: z.string().optional(),
  /**
   * Who may see this show. OPTIONAL here although the API always sends it: a
   * published SDK is installed against whatever version of the API a consumer
   * happens to be pointing at, and requiring a field the previous release did
   * not send would make this SDK reject every response from it.
   */
  visibility: podcastVisibilitySchema.optional(),
  /** Disclosure: the show's content was machine-generated. Optional, same reason. */
  aiGenerated: z.boolean().optional(),
});
export type PodcastSummary = z.infer<typeof podcastSummarySchema>;

/**
 * The summary view of a podcast EPISODE returned by the public podcast endpoints
 * (`GET /api/podcasts/:id/episodes`, `GET /api/episodes/:id`) — just enough to
 * list an episode and stream its audio.
 *
 * ## `enclosureUrl` is OPTIONAL, and that is a bug fix rather than a loosening
 *
 * It used to be required, on the reasoning that "an episode with no enclosure is
 * unplayable, so a row missing it is malformed". That reasoning holds only for
 * RSS-mirrored episodes. A SYRA-HOSTED episode — everything created through
 * `createPodcast`/`uploadEpisode`/the ingest ticket — has no enclosure at all:
 * its audio lives at `audioSource.url`, a path on the Syra API. So the required
 * field made this SDK silently DROP every Syra-hosted episode from
 * `getPodcastEpisodes` and throw on one from `getEpisode` — the entire
 * first-party catalogue, invisible, with no error to notice.
 *
 * The two are alternatives, not a required field and an optional one:
 *
 *   enclosureUrl      an ABSOLUTE external URL (RSS mirror)
 *   audioSource.url   a PATH on the Syra API (Syra-hosted)
 *
 * `SyraClient.episodeAudioUrl` is the one place that resolves either into
 * something playable, so no consumer has to know which kind it holds.
 *
 * `enclosureType` / `enclosureLength` describe the external file (MIME type and
 * byte length); `duration` is the runtime in seconds and `pubDate` the ISO
 * publish timestamp.
 *
 * Artwork mirrors the podcast SHOW: `image` is the re-hosted Syra image id
 * (resolved via `/api/images/:id`); `imageSizes` is the multi-resolution variant
 * set (each variant `url` is `/api/images/:id`); `imageSourceUrl` keeps the
 * original external artwork URL as an absolute fallback when re-hosting has not
 * run yet.
 */
/**
 * Where a Syra-hosted episode's audio actually is.
 *
 * `url` is a PATH on the Syra API (`/api/podcasts/episodes/:id/audio`), not an
 * absolute URL — resolve it with `SyraClient.episodeAudioUrl` rather than
 * handing it to a player directly.
 */
export const episodeAudioSourceSchema = z.object({
  url: z.string(),
  format: z.string().optional(),
  bitrate: z.number().optional(),
  duration: z.number().optional(),
});
export type EpisodeAudioSource = z.infer<typeof episodeAudioSourceSchema>;

/**
 * An episode's processing state. `ready` is playable; `processing` is an episode
 * whose audio is still being packaged (including one drafted but not yet
 * ingested), and only its OWNER is shown those.
 */
export const episodeStatusSchema = z.enum(['ready', 'processing', 'failed', 'unavailable']);
export type EpisodeStatus = z.infer<typeof episodeStatusSchema>;

export const episodeSummarySchema = z.object({
  id: z.string(),
  podcastId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  /** ABSOLUTE, and present only for RSS-mirrored episodes — see the note above. */
  enclosureUrl: z.string().optional(),
  enclosureType: z.string().optional(),
  enclosureLength: z.number().optional(),
  /** A PATH on the Syra API, present for Syra-hosted episodes. */
  audioSource: episodeAudioSourceSchema.optional(),
  duration: z.number().optional(),
  pubDate: z.string().optional(),
  season: z.number().optional(),
  episodeNumber: z.number().optional(),
  status: episodeStatusSchema.optional(),
  /** Disclosure: this episode's content was machine-generated. */
  aiGenerated: z.boolean().optional(),
  image: z.string().optional(),
  imageSizes: coverArtSizesSchema.optional(),
  imageSourceUrl: z.string().optional(),
});
export type EpisodeSummary = z.infer<typeof episodeSummarySchema>;

/** What `createEpisodeDraft` hands back: the episode to fill, and the capability to fill it. */
export const episodeDraftSchema = z.object({
  episodeId: z.string(),
  ingestTicket: z.string(),
  expiresAt: z.string(),
});
export type EpisodeDraft = z.infer<typeof episodeDraftSchema>;

/**
 * What `deletePodcast` hands back — a receipt, and it is worth reading rather
 * than discarding.
 *
 * Both counts are of things that were actually removed by THIS call, so they are
 * how a caller mirroring the delete elsewhere can tell a real deletion from a
 * no-op. `objectsDeleted` counts stored objects (source audio, manifests and
 * every segment beside them); a show whose episodes were never ingested reports
 * zero for both, which is a success, not a failure.
 */
export const podcastDeletedSchema = z.object({
  id: z.string(),
  episodesDeleted: z.number(),
  objectsDeleted: z.number(),
});
export type PodcastDeleted = z.infer<typeof podcastDeletedSchema>;

/** What `deleteEpisode` hands back. `podcastId` names the show it was removed from. */
export const episodeDeletedSchema = z.object({
  id: z.string(),
  podcastId: z.string(),
  objectsDeleted: z.number(),
});
export type EpisodeDeleted = z.infer<typeof episodeDeletedSchema>;

/** What `getEpisodeStream` hands back: a tokenized HLS URL with its own deadline. */
export const episodeStreamSchema = z.object({
  url: z.string(),
  type: z.string(),
  expiresAt: z.string().optional(),
});
export type EpisodeStream = z.infer<typeof episodeStreamSchema>;

/** What the image upload endpoint hands back. */
export const uploadedImageSchema = z.object({
  id: z.string(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
});
export type UploadedImage = z.infer<typeof uploadedImageSchema>;
