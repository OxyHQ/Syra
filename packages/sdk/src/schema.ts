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
export const podcastSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  author: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  imageSizes: coverArtSizesSchema.optional(),
  imageSourceUrl: z.string().optional(),
});
export type PodcastSummary = z.infer<typeof podcastSummarySchema>;

/**
 * The summary view of a podcast EPISODE returned by the public podcast endpoints
 * (`GET /api/podcasts/:id/episodes`, `GET /api/episodes/:id`) — just enough to
 * list an episode and stream its audio.
 *
 * `enclosureUrl` is the direct audio file URL (e.g.
 * `https://api.fastcast.ai/audio/<guid>.mp3`) and is REQUIRED: an episode with
 * no enclosure is unplayable, so a row missing it is treated as malformed and
 * dropped rather than surfaced as a dead entry. `enclosureType` /
 * `enclosureLength` describe that file (MIME type and byte length); `duration`
 * is the runtime in seconds and `pubDate` the ISO publish timestamp.
 *
 * Artwork mirrors the podcast SHOW: `image` is the re-hosted Syra image id
 * (resolved via `/api/images/:id`); `imageSizes` is the multi-resolution variant
 * set (each variant `url` is `/api/images/:id`); `imageSourceUrl` keeps the
 * original external artwork URL as an absolute fallback when re-hosting has not
 * run yet.
 */
export const episodeSummarySchema = z.object({
  id: z.string(),
  podcastId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  enclosureUrl: z.string(),
  enclosureType: z.string().optional(),
  enclosureLength: z.number().optional(),
  duration: z.number().optional(),
  pubDate: z.string().optional(),
  image: z.string().optional(),
  imageSizes: coverArtSizesSchema.optional(),
  imageSourceUrl: z.string().optional(),
});
export type EpisodeSummary = z.infer<typeof episodeSummarySchema>;
