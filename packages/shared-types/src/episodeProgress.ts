import { z } from 'zod';
import { timestampsSchema } from './common';

export const episodeProgressSchema = timestampsSchema.extend({
  id: z.string(),
  _id: z.string().optional(),
  oxyUserId: z.string(),
  episodeId: z.string(),
  positionSec: z.number(),
  durationSec: z.number(),
  completed: z.boolean(),
});
export type EpisodeProgress = z.infer<typeof episodeProgressSchema>;

export const updateEpisodeProgressRequestSchema = z.object({
  episodeId: z.string(),
  positionSec: z.number(),
  durationSec: z.number().optional(),
  completed: z.boolean().optional(),
});
export type UpdateEpisodeProgressRequest = z.infer<typeof updateEpisodeProgressRequestSchema>;
