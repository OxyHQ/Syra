import { z } from 'zod';
import { publicApi } from '@/utils/api';

/**
 * Podcast directory discovery — resolves a free-text query to feed candidates
 * via the backend, which fans out to the Podcast Index + Apple iTunes Search
 * directories. Candidates are NOT persisted; selecting one imports its feed
 * (`podcastService.importFeed`) and then opens the resulting show.
 *
 * The directory candidate is not part of `@syra/shared-types` (it never reaches
 * the catalog), so its contract is declared and parsed here.
 */

export const podcastDirectoryCandidateSchema = z.object({
  feedUrl: z.string(),
  title: z.string(),
  author: z.string().optional(),
  image: z.string().optional(),
  categories: z.array(z.string()),
  podcastGuid: z.string().optional(),
  podcastIndexId: z.number().optional(),
  appleCollectionId: z.number().optional(),
}).passthrough();
export type PodcastDirectoryCandidate = z.infer<typeof podcastDirectoryCandidateSchema>;

const discoverResponseSchema = z.object({
  data: z.array(podcastDirectoryCandidateSchema),
}).passthrough();

export const podcastDiscoveryService = {
  /** Directory candidates for a query (public; not yet in the catalog). */
  async discover(query: string, params?: { limit?: number }): Promise<PodcastDirectoryCandidate[]> {
    const response = await publicApi.get<unknown>('/podcasts/discover', { q: query, ...params });
    const parsed = discoverResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Invalid podcast discovery response: ${parsed.error.message}`);
    }
    return parsed.data.data;
  },
};
