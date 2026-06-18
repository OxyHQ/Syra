import { useEffect } from 'react';
import { useOxy } from '@oxyhq/services';
import { useMusicPreferencesStore, MusicPreferences } from '@/stores/musicPreferencesStore';

/**
 * Hook to access and manage music preferences
 * Automatically loads preferences when authenticated
 */
export function useMusicPreferences() {
  const { canUsePrivateApi, isPrivateApiPending } = useOxy();
  const preferences = useMusicPreferencesStore((state) => state.preferences);
  const loading = useMusicPreferencesStore((state) => state.loading);
  const error = useMusicPreferencesStore((state) => state.error);
  const loadPreferences = useMusicPreferencesStore((state) => state.loadPreferences);
  const updatePreferences = useMusicPreferencesStore((state) => state.updatePreferences);

  useEffect(() => {
    if (isPrivateApiPending) {
      return;
    }

    loadPreferences(canUsePrivateApi);
  }, [canUsePrivateApi, isPrivateApiPending, loadPreferences]);

  return {
    preferences: preferences || null,
    loading,
    error,
    updatePreferences,
    refreshPreferences: () => loadPreferences(canUsePrivateApi),
  };
}

/**
 * Get current music preferences (synchronous, may be null)
 */
export function useCurrentMusicPreferences(): MusicPreferences | null {
  return useMusicPreferencesStore((state) => state.preferences);
}




