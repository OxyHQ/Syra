import { z } from 'zod';
import { radioSeedSchema } from './radio';
import { trackSchema } from './track';
import { playableItemSchema, playableRefSchema } from './upload';

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
  /** A locker item can be playing, so this carries the kind tag too. */
  track: playableItemSchema,
  state: playbackStateSchema,
  position: playbackPositionSchema,
  volume: z.number(),
  shuffle: shuffleModeSchema,
  repeat: repeatModeSchema,
  context: playbackContextSchema.optional(),
});
export type NowPlaying = z.infer<typeof nowPlayingSchema>;

/**
 * The queue holds {@link playableItemSchema}, not bare tracks.
 *
 * A locker item serialises to a Track-shaped DTO PLUS `kind: 'upload'`, and that
 * tag is the only thing telling the player to resolve its stream through
 * `/api/uploads/:id/stream` rather than `/api/stream/:trackId`. Typing the
 * elements as `trackSchema` would leave the tag present at runtime (the queue is
 * JSON in Redis; nothing re-parses it) but invisible to the type — so the client
 * could not branch on it without a cast, and any zod parse would strip it. That
 * is a mechanism that typechecks and does not work.
 */
export const queueSchema = z.object({
  current: z.number(),
  tracks: z.array(playableItemSchema),
  context: playbackContextSchema.optional(),
});
export type Queue = z.infer<typeof queueSchema>;

export const queueWithMetadataSchema = queueSchema.extend({
  previous: z.array(playableItemSchema),
  next: z.array(playableItemSchema),
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

/**
 * The queue is addressed by {@link playableRefSchema}, not by bare ids.
 *
 * An id alone is ambiguous across two collections, and resolving it by trying
 * the catalog first and falling back to the locker would put the owner check on
 * the second attempt only. With the kind stated up front, `track` resolves
 * through `playableTrackFilter` and `upload` resolves scoped to the caller's own
 * `ownerOxyUserId` — so somebody else's locker item is not addressable at all.
 */
export const replaceQueueRequestSchema = z.object({
  refs: z.array(playableRefSchema).min(1),
  current: z.number().int().min(0),
  context: playbackContextSchema.optional(),
});
export type ReplaceQueueRequest = z.infer<typeof replaceQueueRequestSchema>;

export const addToQueueRequestSchema = z.object({
  refs: z.array(playableRefSchema),
  position: z.union([z.enum(['next', 'last']), z.number()]).optional(),
});
export type AddToQueueRequest = z.infer<typeof addToQueueRequestSchema>;

export const removeFromQueueRequestSchema = z.object({
  refs: z.array(playableRefSchema),
});
export type RemoveFromQueueRequest = z.infer<typeof removeFromQueueRequestSchema>;
