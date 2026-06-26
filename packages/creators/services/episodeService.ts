import { Platform } from 'react-native';
import { z } from 'zod';
import { episodeSchema, type Episode, type EpisodeType } from '@syra/shared-types';
import { api } from '@/utils/api';

const episodeResponseSchema = episodeSchema.passthrough();
const uploadEpisodeResponseSchema = z.object({ data: episodeResponseSchema });

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
}

/**
 * Episode API service. The backend expects multipart form data with the audio
 * under the `audioFile` field (multer `.single('audioFile')`); the episode is
 * created with `status: 'processing'` and transitions to `ready` once HLS
 * ingest finishes.
 */
export const episodeService = {
  async uploadEpisode(
    podcastId: string,
    audioFile: EpisodeAudioFile,
    metadata: UploadEpisodeMetadata,
  ): Promise<Episode> {
    const formData = new FormData();

    const fileName = audioFile.name || `episode-${Date.now()}.mp3`;
    const fileType = audioFile.type || 'audio/mpeg';

    if (Platform.OS === 'web') {
      // Web: prefer the picked File; otherwise fetch the blob URL.
      const blob = audioFile.file ?? (await (await fetch(audioFile.uri)).blob());
      formData.append('audioFile', blob, fileName);
    } else {
      // React Native FormData accepts a { uri, name, type } descriptor, which is
      // not part of the DOM FormData.append signature, so it goes through a typed
      // Blob view.
      const rnFilePart = { uri: audioFile.uri, name: fileName, type: fileType } as unknown as Blob;
      formData.append('audioFile', rnFilePart, fileName);
    }

    formData.append('title', metadata.title);
    if (metadata.description) formData.append('description', metadata.description);
    if (metadata.summary) formData.append('summary', metadata.summary);
    if (metadata.season !== undefined) formData.append('season', String(metadata.season));
    if (metadata.episodeNumber !== undefined) formData.append('episodeNumber', String(metadata.episodeNumber));
    if (metadata.episodeType) formData.append('episodeType', metadata.episodeType);
    if (metadata.explicit !== undefined) formData.append('explicit', String(metadata.explicit));
    if (metadata.duration !== undefined) formData.append('duration', String(metadata.duration));

    const response = await api.post<unknown>(`/podcasts/${podcastId}/episodes`, formData);
    const parsed = uploadEpisodeResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Invalid upload episode response: ${parsed.error.message}`);
    }
    return parsed.data.data;
  },
};
