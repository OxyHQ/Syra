import { z } from 'zod';
import { catalogSourceSchema, trackImageSchema } from './track';

export const externalArtistSchema = z.object({
  name: z.string(),
  externalId: z.string(),
  images: z.array(trackImageSchema).optional(),
});
export type ExternalArtist = z.infer<typeof externalArtistSchema>;

export const externalPopularitySchema = z.object({
  playCount: z.number().optional(),
  favoriteCount: z.number().optional(),
  repostCount: z.number().optional(),
});
export type ExternalPopularity = z.infer<typeof externalPopularitySchema>;

export const externalTrackSchema: z.ZodType<ExternalTrack> = z.lazy(() =>
  z.object({
    provider: catalogSourceSchema,
    externalId: z.string(),
    title: z.string(),
    artists: z.array(externalArtistSchema),
    album: externalAlbumSchema.optional(),
    durationSec: z.number(),
    isrc: z.string().optional(),
    images: z.array(trackImageSchema).optional(),
    genre: z.string().optional(),
    mood: z.string().optional(),
    tags: z.array(z.string()).optional(),
    releaseDate: z.string().optional(),
    popularity: externalPopularitySchema.optional(),
    streamUrl: z.string().optional(),
    downloadUrl: z.string().optional(),
    license: z.string().optional(),
  })
);

export type ExternalTrack = {
  provider: z.infer<typeof catalogSourceSchema>;
  externalId: string;
  title: string;
  artists: ExternalArtist[];
  album?: ExternalAlbum;
  durationSec: number;
  isrc?: string;
  images?: z.infer<typeof trackImageSchema>[];
  genre?: string;
  mood?: string;
  tags?: string[];
  releaseDate?: string;
  popularity?: ExternalPopularity;
  streamUrl?: string;
  downloadUrl?: string;
  license?: string;
};

export const externalAlbumSchema: z.ZodType<ExternalAlbum> = z.lazy(() =>
  z.object({
    name: z.string(),
    externalId: z.string(),
    images: z.array(trackImageSchema).optional(),
    releaseDate: z.string().optional(),
    genre: z.string().optional(),
    popularity: externalPopularitySchema.optional(),
    trackExternalIds: z.array(z.string()).optional(),
    tracks: z.array(externalTrackSchema).optional(),
  })
);

export type ExternalAlbum = {
  name: string;
  externalId: string;
  images?: z.infer<typeof trackImageSchema>[];
  releaseDate?: string;
  genre?: string;
  popularity?: ExternalPopularity;
  trackExternalIds?: string[];
  tracks?: ExternalTrack[];
};

export const externalPlaylistSchema = z.object({
  name: z.string(),
  externalId: z.string(),
  images: z.array(trackImageSchema).optional(),
  description: z.string().optional(),
  genre: z.string().optional(),
  popularity: externalPopularitySchema.optional(),
  trackExternalIds: z.array(z.string()).optional(),
  tracks: z.array(externalTrackSchema).optional(),
});
export type ExternalPlaylist = z.infer<typeof externalPlaylistSchema>;
