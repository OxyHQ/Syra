import { z } from 'zod';

/**
 * Generated episodes: a creator, or an agent acting for them through Syra's
 * MCP server, asks Syra to write and voice an episode of a show they own.
 * See the backend's `docs/podcast-generation.md`.
 */

export const generationFormatSchema = z.enum([
  'podcast',
  'news',
  'debate',
  'interview',
  'explainer',
]);
export type GenerationFormat = z.infer<typeof generationFormatSchema>;

export const generationStatusSchema = z.enum([
  'queued',
  'writing',
  'recording',
  'assembling',
  'publishing',
  'completed',
  'failed',
]);
export type GenerationStatus = z.infer<typeof generationStatusSchema>;

/**
 * `POST /api/podcasts/:id/episodes/generate`. Everything is optional once the
 * show has a brief: "another episode" is one press, and the show already knows
 * what it is about.
 */
export const generateEpisodeRequestSchema = z.object({
  /** What this episode covers. Absent: the script chooses from the brief. */
  topic: z.string().trim().min(1).max(2000).optional(),
  /** The episode's name. Absent: the script names it. */
  title: z.string().trim().min(1).max(200).optional(),
  /** Source material to work from. */
  notes: z.string().max(20_000).optional(),
  /** What the show is about. Needed on its first generated episode when it has no description. */
  brief: z.string().trim().min(10).max(4000).optional(),
  /** Who speaks, chosen on the show's first generated episode. */
  format: generationFormatSchema.optional(),
});
export type GenerateEpisodeRequest = z.infer<typeof generateEpisodeRequestSchema>;

export const generationSegmentSchema = z.object({
  speaker: z.string(),
  text: z.string(),
  renderFailed: z.boolean().optional(),
});
export type GenerationSegment = z.infer<typeof generationSegmentSchema>;

/** A generated episode's job, as its owner sees it. */
export const episodeGenerationSchema = z.object({
  episodeId: z.string(),
  podcastId: z.string(),
  status: generationStatusSchema,
  progress: z.number().int().min(0).max(100),
  /** What it covers: the one asked for, or the one the script chose. */
  topic: z.string().nullable(),
  segments: z.array(generationSegmentSchema),
  /** Why it failed, in words for the owner. */
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EpisodeGeneration = z.infer<typeof episodeGenerationSchema>;
