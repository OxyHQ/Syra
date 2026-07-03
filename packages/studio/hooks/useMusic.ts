import { useCallback, useState } from 'react';
import { useOxy } from '@oxyhq/services';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateAlbumRequest, Track } from '@syra/shared-types';
import {
  musicService,
  type TrackAudioFile,
  type UploadTrackMetadata,
} from '@/services/musicService';
import { MUSIC_QUERY_KEYS } from '@/hooks/useArtist';

/** Albums belonging to an artist, for the upload screen's album picker. */
export function useMyAlbums(artistId: string | undefined) {
  const { canUsePrivateApi } = useOxy();
  return useQuery({
    queryKey: MUSIC_QUERY_KEYS.albums(artistId ?? ''),
    queryFn: () => musicService.getMyAlbums(artistId as string),
    enabled: Boolean(artistId) && canUsePrivateApi,
    staleTime: 1000 * 30,
  });
}

/** Create an album, then refresh the artist's album list + dashboard. */
export function useCreateAlbum() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAlbumRequest) => musicService.createAlbum(input),
    onSuccess: (album) => {
      queryClient.invalidateQueries({ queryKey: MUSIC_QUERY_KEYS.albums(album.artistId) });
      queryClient.invalidateQueries({ queryKey: MUSIC_QUERY_KEYS.dashboard });
    },
  });
}

export type TrackUploadPhase = 'idle' | 'uploading' | 'processing' | 'ready' | 'failed';

export interface UploadTrackVariables {
  audioFile: TrackAudioFile;
  metadata: UploadTrackMetadata;
}

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 60; // ~2 minutes before we hand off to the dashboard.

function isTerminal(status: Track['status']): boolean {
  return status === 'ready' || status === 'failed';
}

/**
 * Upload a track, then poll `GET /tracks/:id` until ingest reaches a terminal
 * status (`ready`/`failed`) or the poll budget is exhausted. `phase` drives the
 * upload UI (uploading → processing → ready/failed); the resolved value is the
 * latest track so the screen can branch on `status`.
 */
export function useUploadTrack() {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<TrackUploadPhase>('idle');

  const mutation = useMutation({
    mutationFn: async ({ audioFile, metadata }: UploadTrackVariables): Promise<Track> => {
      setPhase('uploading');
      const created = await musicService.uploadTrack(audioFile, metadata);

      if (isTerminal(created.status)) {
        setPhase(created.status);
        return created;
      }

      setPhase('processing');
      let latest = created;
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        latest = await musicService.getTrack(created.id);
        if (isTerminal(latest.status)) {
          setPhase(latest.status);
          return latest;
        }
      }
      // Timed out while still processing — leave `phase` as 'processing' so the
      // screen can tell the creator it will finish in the background.
      return latest;
    },
    onSuccess: (track) => {
      queryClient.invalidateQueries({ queryKey: MUSIC_QUERY_KEYS.dashboard });
      queryClient.invalidateQueries({ queryKey: MUSIC_QUERY_KEYS.albums(track.artistId) });
    },
    onError: () => {
      setPhase('failed');
    },
  });

  const reset = useCallback(() => {
    setPhase('idle');
    mutation.reset();
  }, [mutation]);

  return { ...mutation, phase, reset };
}
