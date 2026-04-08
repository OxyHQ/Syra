import { useEffect } from 'react';
import { useOxy } from '@oxyhq/services';
import { useMusicPreferencesStore, MusicPreferences } from '@/stores/musicPreferencesStore';

/**
 * Hook to access and manage music preferences
 * Automatically loads preferences when authenticated
 */
export function useMusicPreferences() {
  const { isAuthenticated } = useOxy();
  const preferences = useMusicPreferencesStore((state) => state.preferences);
  const loading = useMusicPreferencesStore((state) => state.loading);
  const error = useMusicPreferencesStore((state) => state.error);
  const loadPreferences = useMusicPreferencesStore((state) => state.loadPreferences);
  const updatePreferences = useMusicPreferencesStore((state) => state.updatePreferences);

  useEffect(() => {
    if (isAuthenticated) {
      loadPreferences(true);
    } else {
      loadPreferences(false);
    }
  }, [isAuthenticated, loadPreferences]);

  return {
    preferences: preferences || null,
    loading,
    error,
    updatePreferences,
    refreshPreferences: () => loadPreferences(isAuthenticated),
  };
}

/**
 * Get current music preferences (synchronous, may be null)
 */
export function useCurrentMusicPreferences(): MusicPreferences | null {
  return useMusicPreferencesStore((state) => state.preferences);
}






