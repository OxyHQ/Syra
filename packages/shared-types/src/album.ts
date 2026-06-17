import { z } from 'zod';
import { timestampsSchema } from './common';
import {
  trackSchema,
  catalogSourceSchema,
  externalIdsSchema,
  sourceProvenanceSchema,
} from './track';

const albumTypeSchema = z.enum(['album', 'single', 'ep', 'compilation']);

export const albumSchema = timestampsSchema.extend({
  id: z.string(),
  _id: z.string().optional(),
  title: z.string(),
  artistId: z.string(),
  artistName: z.string(),
  releaseDate: z.string(),
  coverArt: z.string(),
  genre: z.array(z.string()).optional(),
  totalTracks: z.number(),
  totalDuration: z.number(),
  type: albumTypeSchema,
  label: z.string().optional(),
  copyright: z.string().optional(),
  upc: z.string().optional(),
  popularity: z.number().optional(),
  playCount: z.number().optional(),
  favoriteCount: z.number().optional(),
  repostCount: z.number().optional(),
  isExplicit: z.boolean(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  source: catalogSourceSchema.optional(),
  externalIds: externalIdsSchema.optional(),
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
