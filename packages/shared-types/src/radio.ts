import { z } from 'zod';
import { trackSchema } from './track';

/** What a radio station is built around. */
export const radioSeedTypeSchema = z.enum([
  'track',
  'artist',
  'album',
  'playlist',
  'genre',
  'mood',
  'user',
]);
export type RadioSeedType = z.infer<typeof radioSeedTypeSchema>;

/**
 * The identity of a station. `seedId` is the empty string for `seedType: 'user'`
 * — there the listener themselves is the seed, so there is nothing to point at.
 */
export const radioSeedSchema = z.object({
  seedType: radioSeedTypeSchema,
  seedId: z.string(),
});
export type RadioSeed = z.infer<typeof radioSeedSchema>;

/**
 * A station's presentation layer: the seed plus what the UI needs to render it
 * as a card or a now-playing header. `personalized` is true when the ordering
 * used the listener's taste profile; `wrapped` is true when the generator ran
 * out of fresh candidates and looped back over the pool.
 */
export const radioStationSchema = z.object({
  seedType: radioSeedTypeSchema,
  seedId: z.string(),
  title: z.string(),
  subtitle: z.string(),
  imageUrl: z.string().optional(),
  personalized: z.boolean(),
  wrapped: z.boolean(),
});
export type RadioStation = z.infer<typeof radioStationSchema>;

/**
 * Why playback stopped short for a listener who is not signed in, and how many
 * seconds of each track they may hear before it does.
 */
export const radioGateSchema = z.object({
  reason: z.literal('guest-preview-limit'),
  previewSeconds: z.number(),
});
export type RadioGate = z.infer<typeof radioGateSchema>;

/**
 * One page of a station. `cursor` is null when the generator has no more tracks
 * to hand out; `gate` is null for listeners with unrestricted playback.
 */
export const radioPageSchema = z.object({
  station: radioStationSchema,
  tracks: z.array(trackSchema),
  cursor: z.string().nullable(),
  gate: radioGateSchema.nullable(),
});
export type RadioPage = z.infer<typeof radioPageSchema>;
