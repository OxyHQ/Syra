import { create } from 'zustand';
import { api, isUnauthorizedError } from '@/utils/api';
import { Storage } from '@/utils/storage';

const MUSIC_PREFERENCES_CACHE_KEY = 'syra_music_preferences';

function unwrapApiData<T>(value: T | { data: T } | null | undefined): T | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'object' && value !== null) {
    const recordValue = value as Record<string, any>;
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
  directAudiusStreaming?: boolean;
  monoAudio?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

const DEFAULT_PREFERENCES: Omit<MusicPreferences, 'oxyUserId'> = {
  defaultVolume: 0.7,
  autoplay: true,
  crossfade: 0,
  gaplessPlayback: true,
  normalizeVolume: true,
  explicitContent: true,
  audioQuality: 'normal',
  downloadQuality: 'normal',
  dataSaver: false,
  directAudiusStreaming: false,
  monoAudio: false,
};

interface MusicPreferencesStore {
  preferences: MusicPreferences | null;
  loading: boolean;
  error: string | null;
  loadPreferences: (isAuthenticated?: boolean) => Promise<void>;
  updatePreferences: (partial: Partial<MusicPreferences>) => Promise<MusicPreferences | null>;
}

/**
 * Music preferences store with caching
 */
export const useMusicPreferencesStore = create<MusicPreferencesStore>((set, get) => ({
  preferences: null,
  loading: false,
  error: null,

  async loadPreferences(isAuthenticated?: boolean) {
    try {
      set({ loading: true, error: null });
      
      // Load from cache first for instant access
      const cachedRaw = await Storage.get<MusicPreferences | { data: MusicPreferences }>(MUSIC_PREFERENCES_CACHE_KEY);
      const cached = unwrapApiData<MusicPreferences>(cachedRaw);
      if (cached) {
        set({ preferences: cached });
      }

      // Only fetch from API if user is authenticated
      if (isAuthenticated === false) {
        set({ loading: false });
        return;
      }

      // Fetch fresh data from API
      const res = await api.get<MusicPreferences>('/music/preferences/me');
      const doc = unwrapApiData<MusicPreferences>(res.data);
      
      // Cache the preferences
      if (doc) {
        await Storage.set(MUSIC_PREFERENCES_CACHE_KEY, doc);
        set({ preferences: doc, loading: false });
      } else {
        set({ loading: false });
      }
    } catch (e: unknown) {
      if (isUnauthorizedError(e)) {
        set({ loading: false, error: null });
        return;
      }
      set({ loading: false, error: getErrorMessage(e) || 'Failed to load music preferences' });
    }
  },

  async updatePreferences(partial: Partial<MusicPreferences>) {
    try {
      set({ loading: true, error: null });
      
      // Optimistic update
      const current = get().preferences;
      if (current) {
        const optimistic = { ...current, ...partial };
        set({ preferences: optimistic });
        await Storage.set(MUSIC_PREFERENCES_CACHE_KEY, optimistic);
      }
      
      const res = await api.put<MusicPreferences>('/music/preferences', partial);
      const doc = unwrapApiData<MusicPreferences>(res.data);

      if (doc) {
        // Update cache with server response
        await Storage.set(MUSIC_PREFERENCES_CACHE_KEY, doc);
        set({ preferences: doc, loading: false });
        return doc;
      }

      set({ loading: false });
      return null;
    } catch (e: unknown) {
      // Revert optimistic update on error
      const cached = await Storage.get<MusicPreferences>(MUSIC_PREFERENCES_CACHE_KEY);
      if (cached) {
        set({ preferences: cached });
      }
      set({ loading: false, error: getErrorMessage(e) || 'Failed to update music preferences' });
      return null;
    }
  },
}));




