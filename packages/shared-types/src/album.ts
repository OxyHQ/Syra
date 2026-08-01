import { z } from 'zod';
import { timestampsSchema } from './common';
import {
  trackSchema,
  catalogSourceSchema,
  catalogImageSizesSchema,
  externalIdsSchema,
  imageLicenceSchema,
  sourceProvenanceSchema,
} from './track';

const albumTypeSchema = z.enum(['album', 'single', 'ep', 'compilation']);

/**
 * External identifiers for a release.
 *
 * `musicbrainzReleaseId` is dedup tier 2 for album resolution, behind `upc`
 * (which is a top-level field and already carries its own sparse-unique index).
 * It stays off the shared `externalIds` shape because a track has no use for a
 * release MBID.
 */
export const albumExternalIdsSchema = externalIdsSchema.extend({
  musicbrainzReleaseId: z.string().optional(),
});
export type AlbumExternalIds = z.infer<typeof albumExternalIdsSchema>;

export const albumSchema = timestampsSchema.extend({
  id: z.string(),
  _id: z.string().optional(),
  title: z.string(),
  artistId: z.string(),
  artistName: z.string(),
  releaseDate: z.string(),
  /**
   * REQUIRED, and load-bearing. An album is not created at all unless real cover
   * art was found — embedded in the file, or recovered from Cover Art Archive by
   * release MBID. Its tracks stay individually discoverable under the artist
   * instead. A placeholder must never be invented: it is indistinguishable from
   * real art at every later read, so it can never be cleaned up.
   */
  coverArt: z.string(),
  coverArtSizes: catalogImageSizesSchema.optional(),
  /**
   * Licence and authorship of `coverArt`, when it came from outside.
   *
   * Cover Art Archive art is reusable WITH ATTRIBUTION, so it carries the same
   * obligation as a Commons photo and needs the same field. Its absence would
   * be worse than untidy: the importer's rule is that an image whose licence
   * cannot be stored does not get imported, so with nowhere to put the CAA
   * licence the album stays coverless — and `coverArt` is required, so the
   * album is never created at all. That is precisely the blocker CAA exists to
   * clear.
   *
   * Absent means the cover came from the uploaded file's own embedded artwork,
   * which arrives with the same provenance as the audio and credits nobody.
   */
  coverArtLicence: imageLicenceSchema.optional(),
  genre: z.array(z.string()).optional(),
  totalTracks: z.number(),
  totalDuration: z.number(),
  type: albumTypeSchema,
  label: z.string().optional(),
  copyright: z.string().optional(),
  /** Dedup tier 1 for album resolution — sparse-unique in the model. */
  upc: z.string().optional(),
  catalogNumber: z.string().optional(),
  /** Edition medium as the source names it — `CD`, `Vinyl`, `Digital Media`, … */
  media: z.string().optional(),
  releaseCountry: z.string().optional(),
  /** `TDOR` — when the work was first released, if this edition is a reissue. */
  originalReleaseDate: z.string().optional(),
  totalDiscs: z.number().optional(),
  popularity: z.number().optional(),
  playCount: z.number().optional(),
  favoriteCount: z.number().optional(),
  repostCount: z.number().optional(),
  isExplicit: z.boolean(),
  /** Creator-controlled container visibility; absent means available (no backfill). */
  isAvailable: z.boolean().optional(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  source: catalogSourceSchema.optional(),
  externalIds: albumExternalIdsSchema.optional(),
  sources: z.array(sourceProvenanceSchema).optional(),
});
export type Album = z.infer<typeof albumSchema>;

export const albumWithTracksSchema = albumSchema.extend({
  tracks: z.array(trackSchema),
});
export type AlbumWithTracks = z.infer<typeof albumWithTracksSchema>;

export const albumTrackSchema = z.object({
  trackId: z.string(),
  trackNumber: z.number(),
  discNumber: z.number().optional(),
  title: z.string(),
  duration: z.number(),
  isExplicit: z.boolean(),
});
export type AlbumTrack = z.infer<typeof albumTrackSchema>;

export const createAlbumRequestSchema = z.object({
  title: z.string(),
  artistId: z.string(),
  releaseDate: z.string(),
  coverArt: z.string(),
  genre: z.array(z.string()).optional(),
  type: albumTypeSchema.optional(),
  label: z.string().optional(),
  copyright: z.string().optional(),
  isExplicit: z.boolean().optional(),
});
export type CreateAlbumRequest = z.infer<typeof createAlbumRequestSchema>;

export const updateAlbumRequestSchema = z.object({
  title: z.string().optional(),
  releaseDate: z.string().optional(),
  coverArt: z.string().optional(),
  genre: z.array(z.string()).optional(),
  type: albumTypeSchema.optional(),
  label: z.string().optional(),
  copyright: z.string().optional(),
});
export type UpdateAlbumRequest = z.infer<typeof updateAlbumRequestSchema>;
