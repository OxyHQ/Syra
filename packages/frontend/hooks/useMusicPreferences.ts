import { useOxy } from '@oxyhq/services';
import {
  getMusicPreferencesErrorMessage,
  MusicPreferences,
  useMusicPreferencesQuery,
  useUpdateMusicPreferences,
} from '@/stores/musicPreferencesStore';

/**
 * Hook to access and manage music preferences
 * Automatically loads preferences when authenticated
 */
export function useMusicPreferences() {
  const { canUsePrivateApi, isPrivateApiPending } = useOxy();
  const preferencesQuery = useMusicPreferencesQuery(!isPrivateApiPending && canUsePrivateApi);
  const updatePreferencesMutation = useUpdateMusicPreferences();

  return {
    preferences: preferencesQuery.data ?? null,
    loading: preferencesQuery.isLoading || updatePreferencesMutation.isPending,
    error: getMusicPreferencesErrorMessage(preferencesQuery.error ?? updatePreferencesMutation.error),
    updatePreferences: updatePreferencesMutation.mutateAsync,
    refreshPreferences: preferencesQuery.refetch,
  };
}

/**
 * Get current music preferences (synchronous, may be null)
 */
export function useCurrentMusicPreferences(): MusicPreferences | null {
  return useMusicPreferences().preferences;
}



