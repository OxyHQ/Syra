import { z } from 'zod';

export const lyricsLineSchema = z.object({
  timeMs: z.number(),
  text: z.string(),
});
export type LyricsLine = z.infer<typeof lyricsLineSchema>;

export const lyricsSchema = z.object({
  trackId: z.string(),
  synced: z.boolean(),
  lines: z.array(lyricsLineSchema),
  plain: z.string().optional(),
  source: z.string(),
  updatedAt: z.string().optional(),
});
export type Lyrics = z.infer<typeof lyricsSchema>;

export const lyricsQuerySchema = z.object({
  trackName: z.string(),
  artistName: z.string(),
  albumName: z.string().optional(),
  durationSec: z.number().optional(),
});
export type LyricsQuery = z.infer<typeof lyricsQuerySchema>;
