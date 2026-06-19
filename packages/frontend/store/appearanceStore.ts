import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, publicApi, isUnauthorizedError } from '@/utils/api';

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

export type ThemeMode = 'light' | 'dark' | 'system';

export interface AppearanceSettings {
  themeMode: ThemeMode;
  primaryColor?: string;
}

export interface UserAppearance {
  oxyUserId: string;
  postsCount?: number;
  appearance: AppearanceSettings;
  profileHeaderImage?: string;
  profileCustomization?: {
    coverPhotoEnabled?: boolean;
    minimalistMode?: boolean;
    displayName?: string;
    coverImage?: string;
  };
  privacy?: {
    profileVisibility?: 'public' | 'private' | 'followers_only';
  };
  interests?: {
    tags?: string[];
  };
  createdAt?: string;
  updatedAt?: string;
}

export const appearanceQueryKeys = {
  all: ['appearance'] as const,
  me: ['appearance', 'me'] as const,
  user: (userId: string) => ['appearance', 'user', userId] as const,
};

function buildAppearancePayload(partial: Partial<UserAppearance>): Partial<UserAppearance> {
  return {
    ...(partial.appearance && { appearance: partial.appearance }),
    ...(Object.prototype.hasOwnProperty.call(partial, 'profileHeaderImage') && {
      profileHeaderImage: partial.profileHeaderImage,
    }),
    ...(partial.profileCustomization && {
      profileCustomization: partial.profileCustomization,
    }),
    ...(partial.interests && {
      interests: partial.interests,
    }),
  };
}

export async function fetchMyAppearanceSettings(): Promise<UserAppearance | null> {
  try {
    const res = await api.get<UserAppearance>('/profile/settings/me');
    return unwrapApiData<UserAppearance>(res.data);
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return null;
    }
    throw error;
  }
}

export async function fetchUserAppearance(userId: string): Promise<UserAppearance | null> {
  const res = await publicApi.get<UserAppearance>(`/profile/design/${userId}`);
  return unwrapApiData<UserAppearance>(res.data);
}

export async function updateMyAppearanceSettings(
  partial: Partial<UserAppearance>,
): Promise<UserAppearance | null> {
  const res = await api.put<UserAppearance>('/profile/settings', buildAppearancePayload(partial));
  return unwrapApiData<UserAppearance>(res.data);
}

export function useMyAppearanceSettings(enabled: boolean) {
  return useQuery<UserAppearance | null, Error>({
    queryKey: appearanceQueryKeys.me,
    enabled,
    queryFn: fetchMyAppearanceSettings,
  });
}

export function useUserAppearance(userId?: string | null) {
  return useQuery<UserAppearance | null, Error>({
    queryKey: userId ? appearanceQueryKeys.user(userId) : [...appearanceQueryKeys.all, 'user', 'missing'],
    enabled: Boolean(userId),
    queryFn: () => (userId ? fetchUserAppearance(userId) : Promise.resolve(null)),
  });
}

export function useUpdateMyAppearanceSettings() {
  const queryClient = useQueryClient();

  return useMutation<UserAppearance | null, Error, Partial<UserAppearance>, { previous?: UserAppearance | null }>({
    mutationFn: updateMyAppearanceSettings,
    onMutate: async (partial) => {
      await queryClient.cancelQueries({ queryKey: appearanceQueryKeys.me });
      const previous = queryClient.getQueryData<UserAppearance | null>(appearanceQueryKeys.me);
      if (previous) {
        const optimistic: UserAppearance = {
          ...previous,
          ...partial,
          appearance: partial.appearance
            ? { ...previous.appearance, ...partial.appearance }
            : previous.appearance,
          profileCustomization: partial.profileCustomization
            ? { ...previous.profileCustomization, ...partial.profileCustomization }
            : previous.profileCustomization,
          interests: partial.interests
            ? { ...previous.interests, ...partial.interests }
            : previous.interests,
        };
        queryClient.setQueryData(appearanceQueryKeys.me, optimistic);
        if (optimistic.oxyUserId) {
          queryClient.setQueryData(appearanceQueryKeys.user(optimistic.oxyUserId), optimistic);
        }
      }
      return { previous };
    },
    onError: (_error, _partial, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(appearanceQueryKeys.me, context.previous);
      }
    },
    onSuccess: (doc) => {
      queryClient.setQueryData(appearanceQueryKeys.me, doc);
      if (doc?.oxyUserId) {
        queryClient.setQueryData(appearanceQueryKeys.user(doc.oxyUserId), doc);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: appearanceQueryKeys.me });
    },
  });
}

export function getAppearanceErrorMessage(error: unknown): string | undefined {
  return getErrorMessage(error);
}
