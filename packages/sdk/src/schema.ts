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
