import { z } from 'zod';
import {
  episodeGenerationSchema,
  type EpisodeGeneration,
  type GenerateEpisodeRequest,
} from '@syra/shared-types';
import { api } from '@/utils/api';

const generationListSchema = z.object({ data: z.array(episodeGenerationSchema) });
const generateResponseSchema = z.object({
  data: z.object({ generation: episodeGenerationSchema }),
});

/** Generated episodes (backend `docs/podcast-generation.md`). */
export const generationService = {
  async listGenerations(podcastId: string): Promise<EpisodeGeneration[]> {
    const response = await api.get<unknown>(`/podcasts/${podcastId}/generations`);
    return generationListSchema.parse(response.data).data;
  },

  async generateEpisode(
    podcastId: string,
    request: GenerateEpisodeRequest,
  ): Promise<EpisodeGeneration> {
    const response = await api.post<unknown>(`/podcasts/${podcastId}/episodes/generate`, request);
    return generateResponseSchema.parse(response.data).data.generation;
  },
};
