import { z } from 'zod';
import { radioSeedSchema } from './radio';
import { trackSchema } from './track';

export const audioQualitySchema = z.enum(['low', 'normal', 'high', 'very_high']);
export type AudioQuality = z.infer<typeof audioQualitySchema>;

export const playbackStateSchema = z.enum([
  'playing',
  'paused',
  'stopped',
  'buffering',
  'error',
]);
export type PlaybackState = z.infer<typeof playbackStateSchema>;

export const repeatModeSchema = z.enum(['off', 'all', 'one']);
export type RepeatMode = z.infer<typeof repeatModeSchema>;
export const RepeatMode = {
  OFF: 'off' as const,
  ALL: 'all' as const,
  ONE: 'one' as const,
};

export const shuffleModeSchema = z.enum(['on', 'off']);
export type ShuffleMode = z.infer<typeof shuffleModeSchema>;

export const playbackPositionSchema = z.object({
  currentTime: z.number(),
  duration: z.number(),
  progress: z.number(),
});
export type PlaybackPosition = z.infer<typeof playbackPositionSchema>;

export const playbackContextSchema = z.object({
  type: z.enum([
    'album',
    'artist',
    'playlist',
    'library',
    'search',
    'track',
    'podcast',
    'episode',
    'radio',
  ]),
  id: z.string().optional(),
  name: z.string().optional(),
  uri: z.string().optional(),
  /** Present iff `type === 'radio'`; lets the client resume the station after a reload. */
  radio: radioSeedSchema.optional(),
});
export type PlaybackContext = z.infer<typeof playbackContextSchema>;

export const nowPlayingSchema = z.object({
  track: trackSchema,
  state: playbackStateSchema,
  position: playbackPositionSchema,
  volume: z.number(),
  shuffle: shuffleModeSchema,
  repeat: repeatModeSchema,
  context: playbackContextSchema.optional(),
});
export type NowPlaying = z.infer<typeof nowPlayingSchema>;

export const queueSchema = z.object({
  current: z.number(),
  tracks: z.array(trackSchema),
  context: playbackContextSchema.optional(),
});
export type Queue = z.infer<typeof queueSchema>;

export const queueWithMetadataSchema = queueSchema.extend({
  previous: z.array(trackSchema),
  next: z.array(trackSchema),
  total: z.number(),
});
export type QueueWithMetadata = z.infer<typeof queueWithMetadataSchema>;

export const seekRequestSchema = z.object({
  position: z.number(),
});
export type SeekRequest = z.infer<typeof seekRequestSchema>;

export const playTrackRequestSchema = z.object({
  trackId: z.string(),
  context: playbackContextSchema.optional(),
  position: z.number().optional(),
});
export type PlayTrackRequest = z.infer<typeof playTrackRequestSchema>;

export const playQueueRequestSchema = z.object({
  queue: queueSchema,
  startIndex: z.number().optional(),
});
export type PlayQueueRequest = z.infer<typeof playQueueRequestSchema>;

export const replaceQueueRequestSchema = z.object({
  trackIds: z.array(z.string()).min(1),
  current: z.number().int().min(0),
  context: playbackContextSchema.optional(),
});
export type ReplaceQueueRequest = z.infer<typeof replaceQueueRequestSchema>;

export const addToQueueRequestSchema = z.object({
  trackIds: z.array(z.string()),
  position: z.union([z.enum(['next', 'last']), z.number()]).optional(),
});
export type AddToQueueRequest = z.infer<typeof addToQueueRequestSchema>;

export const removeFromQueueRequestSchema = z.object({
  trackIds: z.array(z.string()),
});
export type RemoveFromQueueRequest = z.infer<typeof removeFromQueueRequestSchema>;
