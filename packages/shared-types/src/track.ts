import { z } from 'zod';
import { timestampsSchema } from './common';

export const catalogSourceSchema = z.enum(['upload', 'cc', 'audius']);
export type CatalogSource = z.infer<typeof catalogSourceSchema>;

export const trackStatusSchema = z.enum(['processing', 'ready', 'failed']);
export type TrackStatus = z.infer<typeof trackStatusSchema>;

export const externalIdsSchema = z.object({
  isrc: z.string().optional(),
  audiusId: z.string().optional(),
});
export type ExternalIds = z.infer<typeof externalIdsSchema>;

export const sourceProvenanceSchema = z.object({
  provider: catalogSourceSchema,
  externalId: z.string(),
  importedAt: z.string(),
  fields: z.array(z.string()),
});
export type SourceProvenance = z.infer<typeof sourceProvenanceSchema>;

export const trackImageSchema = z.object({
  url: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  source: catalogSourceSchema.optional(),
});
export type TrackImage = z.infer<typeof trackImageSchema>;

export const catalogImageVariantSchema = z.object({
  id: z.string(),
  url: z.string(),
  width: z.number(),
  height: z.number(),
});
export type CatalogImageVariant = z.infer<typeof catalogImageVariantSchema>;

export const catalogImageSizesSchema = z.object({
  small: catalogImageVariantSchema.optional(),
  medium: catalogImageVariantSchema.optional(),
  large: catalogImageVariantSchema.optional(),
  xlarge: catalogImageVariantSchema.optional(),
  xxlarge: catalogImageVariantSchema.optional(),
  original: catalogImageVariantSchema.optional(),
});
export type CatalogImageSizes = z.infer<typeof catalogImageSizesSchema>;

export const hlsRenditionSchema = z.object({
  manifestKey: z.string(),
  bitrateKbps: z.number(),
  encrypted: z.boolean(),
});
export type HlsRendition = z.infer<typeof hlsRenditionSchema>;

export const audioSourceSchema = z.object({
  url: z.string(),
  format: z.enum(['mp3', 'flac', 'ogg', 'm4a', 'wav']),
  bitrate: z.number().optional(),
  duration: z.number().optional(),
});
export type AudioSource = z.infer<typeof audioSourceSchema>;

export const trackMetadataSchema = z.object({
  genre: z.array(z.string()).optional(),
  bpm: z.number().optional(),
  key: z.string().optional(),
  explicit: z.boolean().optional(),
  language: z.string().optional(),
  isrc: z.string().optional(),
  copyright: z.string().optional(),
  publisher: z.string().optional(),
});
export type TrackMetadata = z.infer<typeof trackMetadataSchema>;

export const trackSchema = timestampsSchema.extend({
  id: z.string(),
  _id: z.string().optional(),
  title: z.string(),
  artistId: z.string(),
  artistName: z.string(),
  albumId: z.string().optional(),
  albumName: z.string().optional(),
  duration: z.number(),
  trackNumber: z.number().optional(),
  discNumber: z.number().optional(),
  audioSource: audioSourceSchema.optional(),
  coverArt: z.string().optional(),
  coverArtSizes: catalogImageSizesSchema.optional(),
  metadata: trackMetadataSchema.optional(),
  genre: z.string().optional(),
  mood: z.string().optional(),
  tags: z.array(z.string()).optional(),
  releaseDate: z.string().optional(),
  isExplicit: z.boolean(),
  popularity: z.number().optional(),
  playCount: z.number().optional(),
  favoriteCount: z.number().optional(),
  repostCount: z.number().optional(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  isAvailable: z.boolean(),
  copyrightRemoved: z.boolean().optional(),
  removedAt: z.string().optional(),
  removedReason: z.string().optional(),
  removedBy: z.string().optional(),
  copyrightReportId: z.string().optional(),
  source: catalogSourceSchema,
  status: trackStatusSchema,
  externalIds: externalIdsSchema.optional(),
  sources: z.array(sourceProvenanceSchema).optional(),
  images: z.array(trackImageSchema).optional(),
  hls: z.array(hlsRenditionSchema).optional(),
  loudnessLufs: z.number().optional(),
  streamUrl: z.string().optional(),
  hlsMasterKey: z.string().optional(),
});
export type Track = z.infer<typeof trackSchema>;

export const trackWithContextSchema = trackSchema.extend({
  isLiked: z.boolean().optional(),
  isInPlaylist: z.boolean().optional(),
  playlists: z.array(z.string()).optional(),
});
export type TrackWithContext = z.infer<typeof trackWithContextSchema>;

export const createTrackRequestSchema = z.object({
  title: z.string(),
  artistId: z.string(),
  albumId: z.string().optional(),
  duration: z.number(),
  audioSource: audioSourceSchema,
  coverArt: z.string().optional(),
  metadata: trackMetadataSchema.optional(),
  isExplicit: z.boolean().optional(),
});
export type CreateTrackRequest = z.infer<typeof createTrackRequestSchema>;

export const updateTrackRequestSchema = z.object({
  title: z.string().optional(),
  albumId: z.string().optional(),
  trackNumber: z.number().optional(),
  discNumber: z.number().optional(),
  coverArt: z.string().optional(),
  metadata: trackMetadataSchema.partial().optional(),
  isAvailable: z.boolean().optional(),
});
export type UpdateTrackRequest = z.infer<typeof updateTrackRequestSchema>;

export const uploadTrackRequestSchema = z.object({
  title: z.string(),
  artistId: z.string(),
  albumId: z.string().optional(),
  coverArt: z.string().optional(),
  genre: z.array(z.string()).optional(),
  isExplicit: z.boolean().optional(),
});
export type UploadTrackRequest = z.infer<typeof uploadTrackRequestSchema>;
