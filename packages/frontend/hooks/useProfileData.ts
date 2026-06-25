import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { type UserEntity } from '@/stores/usersStore';
import { useUserAppearance, type UserAppearance } from '@/store/appearanceStore';
import { usePrivacySettings } from './usePrivacySettings';

export interface ProfileDesign {
  displayName: string;
  coverImage?: string;
  avatar?: string;
  coverPhotoEnabled: boolean;
  minimalistMode: boolean;
  primaryColor?: string;
}

export interface ProfileData extends Omit<UserEntity, 'avatar'> {
  id: string;
  username: string;
  avatar?: string;
  postsCount?: number;
  stats?: {
    followers?: number;
    following?: number;
  };
  design: ProfileDesign;
  privacy?: {
    profileVisibility?: 'public' | 'private' | 'followers_only';
  };
}

type RemoteUserProfile = Omit<UserEntity, 'avatar' | 'privacySettings'> & {
  avatar?: string | null;
  privacySettings?: unknown;
};

/**
 * Computes profile design values from Oxy profile + backend customization settings
 */
function computeDesign(
  oxyProfile: UserEntity,
  appearance?: UserAppearance
): ProfileDesign {
  const customization = appearance?.profileCustomization;
  // Canonical display name comes from the Oxy API user contract (`name.displayName`).
  // We do NOT recompose it from `name.full`/`first`/`last`. `customization.displayName`
  // is Syra's own user-set profile override and intentionally takes precedence.
  const canonicalName = typeof oxyProfile?.name === 'string'
    ? oxyProfile.name
    : oxyProfile?.name?.displayName;

  return {
    displayName: customization?.displayName || canonicalName || oxyProfile?.username || '',
    coverImage: customization?.coverImage || appearance?.profileHeaderImage,
    avatar: oxyProfile?.avatar,
    coverPhotoEnabled: customization?.coverPhotoEnabled ?? true,
    minimalistMode: customization?.minimalistMode ?? false,
    primaryColor: appearance?.appearance?.primaryColor,
  };
}

function normalizeProfile(profile: RemoteUserProfile): UserEntity {
  const privacySettings =
    typeof profile.privacySettings === 'object' && profile.privacySettings !== null
      ? profile.privacySettings as Record<string, unknown>
      : undefined;

  return {
    ...profile,
    avatar: profile.avatar ?? undefined,
    privacySettings,
  };
}

/**
 * Unified hook for profile data that combines:
 * - Oxy profile data (from usersStore)
 * - Appearance/customization settings (from appearanceStore)
 * - Privacy settings
 * 
 * Uses proper Zustand selectors to avoid unnecessary re-renders
 */
export function useProfileData(username?: string): {
  data: ProfileData | null;
  loading: boolean;
} {
  const { oxyServices } = useOxy();

  const normalizedUsername = username?.trim().toLowerCase();
  const profileQuery = useQuery<UserEntity | null, Error>({
    queryKey: ['profile', 'username', normalizedUsername ?? 'missing'],
    enabled: Boolean(normalizedUsername),
    queryFn: async () => {
      if (!username) {
        return null;
      }
      const profile = await oxyServices.getProfileByUsername(username);
      return profile ? normalizeProfile(profile) : null;
    },
  });

  const oxyProfile = profileQuery.data;
  const appearanceQuery = useUserAppearance(oxyProfile?.id);
  const appearance = appearanceQuery.data ?? undefined;
  const privacySettings = usePrivacySettings(oxyProfile?.id);

  // Compute unified profile data
  const profileData = useMemo((): ProfileData | null => {
    if (!oxyProfile) return null;

    const design = computeDesign(oxyProfile, appearance);

    // Use privacy from appearance data (from profileDesign endpoint) if available,
    // otherwise fall back to privacySettings hook (requires auth)
    // This ensures unauthenticated users can see privacy info
    const privacy = appearance?.privacy || privacySettings || undefined;

    return {
      ...oxyProfile,
      id: oxyProfile.id || '',
      username: oxyProfile.username || '',
      postsCount: appearance?.postsCount,
      design,
      privacy,
    };
  }, [oxyProfile, appearance, privacySettings]);

  // Loading state: true if username provided but no profile data yet
  const loading = Boolean(username && profileQuery.isLoading);

  return { data: profileData, loading };
}
