import { z } from 'zod';
import { repeatModeSchema } from './player';
import { catalogSourceSchema } from './track';

export const deviceTypeSchema = z.enum(['web', 'mobile', 'desktop', 'speaker']);
export type DeviceType = z.infer<typeof deviceTypeSchema>;

export const deviceSchema = z.object({
  id: z.string().optional(),
  deviceId: z.string(),
  name: z.string(),
  type: deviceTypeSchema,
  capabilities: z.array(z.string()),
  lastSeen: z.string(),
  isActive: z.boolean(),
});
export type Device = z.infer<typeof deviceSchema>;

export const playbackCommandTypeSchema = z.enum([
  'play',
  'pause',
  'seek',
  'next',
  'prev',
  'transfer',
  'volume',
  'shuffle',
  'repeat',
]);
export type PlaybackCommandType = z.infer<typeof playbackCommandTypeSchema>;

export const playbackCommandSchema = z.object({
  type: playbackCommandTypeSchema,
  positionMs: z.number().optional(),
  volume: z.number().optional(),
  shuffle: z.boolean().optional(),
  repeat: repeatModeSchema.optional(),
  deviceId: z.string().optional(),
});
export type PlaybackCommand = z.infer<typeof playbackCommandSchema>;

export const connectPlaybackStateSchema = z.object({
  trackId: z.string().optional(),
  source: catalogSourceSchema.optional(),
  positionMs: z.number(),
  isPlaying: z.boolean(),
  queue: z.array(z.string()),
  contextType: z.string().optional(),
  contextId: z.string().optional(),
  repeat: repeatModeSchema,
  shuffle: z.boolean(),
  volume: z.number(),
  activeDeviceId: z.string().optional(),
  updatedAt: z.string(),
});
export type ConnectPlaybackState = z.infer<typeof connectPlaybackStateSchema>;
