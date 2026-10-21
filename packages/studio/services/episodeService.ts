import { z } from 'zod';
import { episodeSchema, type Episode, type EpisodeType } from '@syra/shared-types';
import { api } from '@/utils/api';
import { uploadAudioDirect } from '@/services/directAudioUpload';

/** Creating the episode waits on the server copying the file into place. */
const UPLOAD_COMPLETE_TIMEOUT_MS = 10 * 60 * 1000;

const episodeResponseSchema = episodeSchema.passthrough();
const uploadEpisodeResponseSchema = z.object({ data: episodeResponseSchema });
const deleteEpisodeResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    podcastId: z.string(),
    objectsDeleted: z.number(),
  }),
});

/**
 * What one episode delete actually destroyed, as the backend counted it.
 *
 * Derived from the schema that parses it rather than written out beside it, so
 * the two cannot drift into disagreeing about the response.
 */
export type EpisodeDeletion = z.infer<typeof deleteEpisodeResponseSchema>['data'];

export interface EpisodeAudioFile {
  uri: string;
  name?: string;
  type?: string;
  /** Present on web when the file came from a DOM picker. */
  file?: File;
}

export interface UploadEpisodeMetadata {
  title: string;
  description?: string;
  summary?: string;
  season?: number;
  episodeNumber?: number;
  episodeType?: EpisodeType;
  explicit?: boolean;
  /** Duration in seconds, when the client could measure it. */
  duration?: number;
  /** Hosts & Guests as Oxy user ids (validated server-side). */
  hosts?: string[];
  guests?: string[];
}

/**
 * Episode API service. The audio is sent straight to storage
 * (`uploadAudioDirect` — the API refuses request bodies over 100 MB and an
 * episode may be 500 MB), then the episode is created by `uploadId` at the same
 * route as always, with `status: 'processing'`; it transitions to `ready` once
 * HLS ingest finishes.
 */
export const episodeService = {
  async uploadEpisode(
    podcastId: string,
    audioFile: EpisodeAudioFile,
    metadata: UploadEpisodeMetadata,
    onProgress?: (fraction: number) => void,
  ): Promise<Episode> {
    const upload = await uploadAudioDirect(
      'episode',
      {
        uri: audioFile.uri,
        name: audioFile.name || `episode-${Date.now()}.mp3`,
        mimeType: audioFile.type || 'audio/mpeg',
        file: audioFile.file,
      },
      onProgress,
    );

    const response = await api.post<unknown>(
      `/podcasts/${podcastId}/episodes`,
      {
        ...upload,
        title: metadata.title,
        ...(metadata.description ? { description: metadata.description } : {}),
        ...(metadata.summary ? { summary: metadata.summary } : {}),
        ...(metadata.season !== undefined ? { season: metadata.season } : {}),
        ...(metadata.episodeNumber !== undefined ? { episodeNumber: metadata.episodeNumber } : {}),
        ...(metadata.episodeType ? { episodeType: metadata.episodeType } : {}),
        ...(metadata.explicit !== undefined ? { explicit: metadata.explicit } : {}),
        ...(metadata.duration !== undefined ? { duration: metadata.duration } : {}),
        ...(metadata.hosts?.length ? { hosts: metadata.hosts } : {}),
        ...(metadata.guests?.length ? { guests: metadata.guests } : {}),
      },
      { timeout: UPLOAD_COMPLETE_TIMEOUT_MS },
    );
    const parsed = uploadEpisodeResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Invalid upload episode response: ${parsed.error.message}`);
    }
    return parsed.data.data;
  },

  /**
   * Permanently delete one episode of a show the caller owns. Takes its HLS
   * ladder, its transcript, its credits and every listener's saved position in
   * it, and purges the audio; the show's `episodeCount` and `lastEpisodeAt` are
   * recomputed server-side in the same transaction. Irreversible —
   * `unpublishEpisode` is the reversible verb, this one is not.
   */
  async deleteEpisode(id: string): Promise<EpisodeDeletion> {
    const response = await api.delete<unknown>(`/episodes/${id}`);
    const parsed = deleteEpisodeResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Invalid delete episode response: ${parsed.error.message}`);
    }
    return parsed.data.data;
  },
};
