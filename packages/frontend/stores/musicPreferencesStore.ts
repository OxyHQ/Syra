import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isUnauthorizedError } from '@/utils/api';
import { queryClient } from '@/lib/queryClient';
import { clearStreamResolutionCache } from '@/services/streamService';

function unwrapApiData<T>(value: T | { data: T } | null | undefined): T | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'object' && value !== null) {
    const recordValue = value as Record<string, unknown>;
    if ('data' in recordValue) {
      const inner = recordValue.data as T | null | undefined;
      return inner ?? null;
    }
  }

  return value as T;
}

function getErrorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export interface MusicPreferences {
  oxyUserId: string;
  defaultVolume: number; // 0-1
  autoplay: boolean;
  crossfade: number; // 0-12 seconds
  gaplessPlayback: boolean;
  normalizeVolume: boolean;
  explicitContent: boolean;
  audioQuality?: 'low' | 'normal' | 'high' | 'very_high';
  downloadQuality?: 'low' | 'normal' | 'high' | 'very_high';
  dataSaver?: boolean;
  monoAudio?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export const DEFAULT_MUSIC_PREFERENCES: Omit<MusicPreferences, 'oxyUserId'> = {
  defaultVolume: 0.7,
  autoplay: true,
  crossfade: 0,
  gaplessPlayback: true,
  normalizeVolume: true,
  explicitContent: true,
  audioQuality: 'normal',
  downloadQuality: 'normal',
  dataSaver: false,
  monoAudio: false,
};

const STREAM_RELEVANT_PREFERENCES: Array<keyof MusicPreferences> = [
  'audioQuality',
  'dataSaver',
];

function touchesStreamPreferences(partial: Partial<MusicPreferences>): boolean {
  return STREAM_RELEVANT_PREFERENCES.some((key) => Object.prototype.hasOwnProperty.call(partial, key));
}

export const musicPreferencesQueryKeys = {
  all: ['musicPreferences'] as const,
  me: ['musicPreferences', 'me'] as const,
};

export async function fetchMusicPreferences(): Promise<MusicPreferences | null> {
  try {
    const res = await api.get<MusicPreferences>('/music/preferences/me');
    return unwrapApiData<MusicPreferences>(res.data);
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return null;
    }
    throw error;
  }
}

export async function updateMusicPreferences(
  partial: Partial<MusicPreferences>,
): Promise<MusicPreferences | null> {
  const res = await api.put<MusicPreferences>('/music/preferences', partial);
  return unwrapApiData<MusicPreferences>(res.data);
}

export function getCurrentMusicPreferences(): MusicPreferences | null {
  return queryClient.getQueryData<MusicPreferences | null>(musicPreferencesQueryKeys.me) ?? null;
}

export function useMusicPreferencesQuery(enabled: boolean) {
  return useQuery<MusicPreferences | null, Error>({
    queryKey: musicPreferencesQueryKeys.me,
    enabled,
    queryFn: fetchMusicPreferences,
  });
}

export function useUpdateMusicPreferences() {
  const activeQueryClient = useQueryClient();

  return useMutation<MusicPreferences | null, Error, Partial<MusicPreferences>, { previous?: MusicPreferences | null }>({
    mutationFn: updateMusicPreferences,
    onMutate: async (partial) => {
      await activeQueryClient.cancelQueries({ queryKey: musicPreferencesQueryKeys.me });
      if (touchesStreamPreferences(partial)) {
        clearStreamResolutionCache();
      }
      const previous = activeQueryClient.getQueryData<MusicPreferences | null>(musicPreferencesQueryKeys.me);
      if (previous) {
        activeQueryClient.setQueryData<MusicPreferences>(musicPreferencesQueryKeys.me, {
          ...previous,
          ...partial,
        });
      }
      return { previous };
    },
    onError: (_error, _partial, context) => {
      if (context?.previous !== undefined) {
        activeQueryClient.setQueryData(musicPreferencesQueryKeys.me, context.previous);
      }
    },
    onSuccess: (doc) => {
      activeQueryClient.setQueryData(musicPreferencesQueryKeys.me, doc);
    },
    onSettled: () => {
      void activeQueryClient.invalidateQueries({ queryKey: musicPreferencesQueryKeys.me });
    },
  });
}

export function getMusicPreferencesErrorMessage(error: unknown): string | undefined {
  return getErrorMessage(error);
}
