import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { z } from 'zod';
import { api, isNotFoundError, isUnauthorizedError } from '@/utils/api';

const PRIVACY_SETTINGS_CACHE_KEY = '@mention_privacy_settings';
const PRIVACY_SETTINGS_STALE_TIME_MS = 1000 * 60 * 5;

const privacySettingsSchema = z.object({
  profileVisibility: z.enum(['public', 'private', 'followers_only']).optional(),
  showContactInfo: z.boolean().optional(),
  allowTags: z.boolean().optional(),
  allowMentions: z.boolean().optional(),
  showOnlineStatus: z.boolean().optional(),
  hideLikeCounts: z.boolean().optional(),
  hideShareCounts: z.boolean().optional(),
  hideReplyCounts: z.boolean().optional(),
  hideSaveCounts: z.boolean().optional(),
  hiddenWords: z.array(z.string()).optional(),
  restrictedUsers: z.array(z.string()).optional(),
});

const privacyResponseSchema = z.object({
  privacy: privacySettingsSchema.optional(),
});

export type PrivacySettings = z.infer<typeof privacySettingsSchema>;

const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  profileVisibility: 'public',
  hideLikeCounts: false,
  hideShareCounts: false,
  hideReplyCounts: false,
  hideSaveCounts: false,
};

const parsePrivacySettings = (value: unknown): PrivacySettings | null => {
  const parsed = privacySettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const readCachedPrivacySettings = async (): Promise<PrivacySettings | null> => {
  try {
    const cached = await AsyncStorage.getItem(PRIVACY_SETTINGS_CACHE_KEY);
    if (!cached) return null;
    return parsePrivacySettings(JSON.parse(cached));
  } catch (error) {
    console.debug('Failed to load cached privacy settings:', error);
    return null;
  }
};

const writeCachedPrivacySettings = async (privacySettings: PrivacySettings) => {
  try {
    await AsyncStorage.setItem(PRIVACY_SETTINGS_CACHE_KEY, JSON.stringify(privacySettings));
  } catch (error) {
    console.debug('Failed to cache privacy settings:', error);
  }
};

/**
 * Hook to fetch privacy settings for a specific user.
 */
export function usePrivacySettings(userId?: string | null): PrivacySettings | null {
  const { data = null } = useQuery({
    queryKey: ['privacySettings', userId],
    enabled: !!userId,
    staleTime: PRIVACY_SETTINGS_STALE_TIME_MS,
    queryFn: async () => {
      try {
        const response = await api.get<{ privacy?: PrivacySettings }>(`/profile/settings/${userId}`);
        const parsed = privacyResponseSchema.safeParse(response.data);
        return parsed.success && parsed.data.privacy
          ? parsed.data.privacy
          : DEFAULT_PRIVACY_SETTINGS;
      } catch (error) {
        if (isNotFoundError(error)) {
          return DEFAULT_PRIVACY_SETTINGS;
        }
        console.debug('Could not load privacy settings:', error);
        return null;
      }
    },
  });

  return data;
}

/**
 * Hook to fetch current user's privacy settings.
 */
export function useCurrentUserPrivacySettings(): PrivacySettings | null {
  const { isAuthenticated } = useOxy();
  const { data = null } = useQuery({
    queryKey: ['privacySettings', 'me', isAuthenticated],
    staleTime: PRIVACY_SETTINGS_STALE_TIME_MS,
    queryFn: async () => {
      const cached = await readCachedPrivacySettings();

      if (!isAuthenticated) {
        return cached ?? DEFAULT_PRIVACY_SETTINGS;
      }

      try {
        const response = await api.get<{ privacy?: PrivacySettings }>('/profile/settings/me');
        const parsed = privacyResponseSchema.safeParse(response.data);
        const freshSettings = parsed.success && parsed.data.privacy
          ? parsed.data.privacy
          : DEFAULT_PRIVACY_SETTINGS;

        await writeCachedPrivacySettings(freshSettings);
        return freshSettings;
      } catch (error) {
        if (isUnauthorizedError(error)) {
          return cached ?? DEFAULT_PRIVACY_SETTINGS;
        }
        if (isNotFoundError(error)) {
          await writeCachedPrivacySettings(DEFAULT_PRIVACY_SETTINGS);
          return DEFAULT_PRIVACY_SETTINGS;
        }
        console.debug('Could not load current user privacy settings:', error);
        return cached ?? DEFAULT_PRIVACY_SETTINGS;
      }
    },
  });

  return data;
}

export async function updatePrivacySettingsCache(privacySettings: PrivacySettings) {
  const parsed = parsePrivacySettings(privacySettings);
  if (!parsed) return;
  await writeCachedPrivacySettings(parsed);
}

export function useUpdatePrivacySettingsCache() {
  const queryClient = useQueryClient();

  return async (privacySettings: PrivacySettings) => {
    await updatePrivacySettingsCache(privacySettings);
    queryClient.setQueryData(['privacySettings', 'me', true], privacySettings);
    queryClient.setQueryData(['privacySettings', 'me', false], privacySettings);
  };
}
