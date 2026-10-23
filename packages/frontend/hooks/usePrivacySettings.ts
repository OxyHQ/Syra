import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import { z } from 'zod';
import { api, isNotFoundError } from '@/utils/api';
import { createScopedLogger } from '@/utils/logger';

const PRIVACY_SETTINGS_CACHE_KEY = '@syra_privacy_settings';
const PRIVACY_SETTINGS_STALE_TIME_MS = 1000 * 60 * 5;
const logger = createScopedLogger('usePrivacySettings');

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

/** OxyProvider owns account-scoped persistence; never read the former global cache. */
function usePrivacyViewer() {
  const context = useOxy();
  const [epoch, setEpoch] = useState(0);
  const { oxyServices } = context;
  useEffect(() => {
    void AsyncStorage.removeItem(PRIVACY_SETTINGS_CACHE_KEY).catch(() => undefined);
    return oxyServices.session.onChange(() => setEpoch((value) => value + 1));
  }, [oxyServices]);
  return { ...context, accountId: context.user?.id ?? null, epoch };
}

/** Privacy belongs to both the verified viewer and requested profile. */
export function usePrivacySettings(userId?: string | null): PrivacySettings | null {
  const { accountId, epoch, oxyServices, canUsePrivateApi } = usePrivacyViewer();
  const { data = null } = useQuery({
    queryKey: ['privacySettings', accountId, userId, epoch],
    enabled: !!accountId && !!userId && canUsePrivateApi,
    staleTime: PRIVACY_SETTINGS_STALE_TIME_MS,
    queryFn: async ({ signal }) => {
      if (!accountId || oxyServices.session.userId !== accountId) return null;
      try {
        const response = await api.get<{ privacy?: PrivacySettings }>(
          `/profile/settings/${encodeURIComponent(userId!)}`,
          undefined,
          { signal },
        );
        if (signal.aborted || oxyServices.session.userId !== accountId) return null;
        const parsed = privacyResponseSchema.safeParse(response.data);
        return parsed.success && parsed.data.privacy
          ? parsed.data.privacy
          : DEFAULT_PRIVACY_SETTINGS;
      } catch (error) {
        if (signal.aborted || oxyServices.session.userId !== accountId) return null;
        if (isNotFoundError(error)) return DEFAULT_PRIVACY_SETTINGS;
        logger.debug('Could not load privacy settings', { error });
        return null;
      }
    },
  });
  return accountId && canUsePrivateApi && oxyServices.session.userId === accountId ? data : null;
}

export function useCurrentUserPrivacySettings(): PrivacySettings | null {
  const { user } = useOxy();
  return usePrivacySettings(user?.id);
}

export function useUpdatePrivacySettingsCache() {
  const queryClient = useQueryClient();
  const { user, oxyServices } = useOxy();
  const accountId = user?.id;
  return async (privacySettings: PrivacySettings) => {
    const parsed = parsePrivacySettings(privacySettings);
    if (!parsed || !accountId || oxyServices.session.userId !== accountId) return;
    // Refresh only this verified account. The provider handles switch/logout disposal.
    await queryClient.invalidateQueries({ queryKey: ['privacySettings', accountId] });
  };
}
