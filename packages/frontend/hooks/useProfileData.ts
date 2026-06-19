import { useEffect, useMemo } from 'react';
import { useOxy } from '@oxyhq/services';
import { useUsersStore, useUserByUsername, type UserEntity } from '@/stores/usersStore';
import { useAppearanceStore, type UserAppearance } from '@/store/appearanceStore';
import { usePrivacySettings } from './usePrivacySettings';
import { createScopedLogger } from '@/utils/logger';

const logger = createScopedLogger('useProfileData');

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

/**
 * Computes profile design values from Oxy profile + backend customization settings
 */
function computeDesign(
  oxyProfile: UserEntity,
  appearance?: UserAppearance
): ProfileDesign {
  const customization = appearance?.profileCustomization;
  const nameValue = typeof oxyProfile?.name === 'string' 
    ? oxyProfile.name 
    : oxyProfile?.name?.full;

  return {
    displayName: customization?.displayName || nameValue || oxyProfile?.username || '',
    coverImage: customization?.coverImage || appearance?.profileHeaderImage,
    avatar: oxyProfile?.avatar,
    coverPhotoEnabled: customization?.coverPhotoEnabled ?? true,
    minimalistMode: customization?.minimalistMode ?? false,
    primaryColor: appearance?.appearance?.primaryColor,
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
  
  // Use existing hooks for store access
  const ensureByUsername = useUsersStore((state) => state.ensureByUsername);
  const loadForUser = useAppearanceStore((state) => state.loadForUser);
  
  // Get user from store using existing hook
  const oxyProfile = useUserByUsername(username);
  
  // Subscribe to appearance settings for this user
  const appearance = useAppearanceStore((state) => {
    const id = oxyProfile?.id;
    return id ? state.byUserId[id] : undefined;
  });
  
  // Load privacy settings
  const privacySettings = usePrivacySettings(oxyProfile?.id);

  // Fetch profile data when username changes
  useEffect(() => {
    if (!username) return;

    let cancelled = false;

    const fetchProfile = async () => {
      try {
        // Fetch fresh data - this will update the store
        const data = await ensureByUsername(
          username,
          async (u) => {
            const profile = await oxyServices.getProfileByUsername(u);
            if (!profile) return profile;
            return {
              ...profile,
              avatar: profile.avatar ?? undefined,
              privacySettings: profile.privacySettings as Record<string, unknown> | undefined,
            } satisfies UserEntity;
          }
        );

        if (!cancelled && data?.id) {
          // Load appearance settings for this user
          await loadForUser(data.id, true);
        }
      } catch (error) {
        logger.debug('Profile fetch error', { error });
      }
    };

    fetchProfile();

    return () => {
      cancelled = true;
    };
  }, [username, ensureByUsername, loadForUser, oxyServices]);

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
  const loading = Boolean(username && !oxyProfile);

  return { data: profileData, loading };
}
