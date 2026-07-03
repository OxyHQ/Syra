import { useOxy } from '@oxyhq/services';
import { useTheme } from '@oxyhq/bloom/theme';
import { useQuery } from '@tanstack/react-query';
import type { LiveConfig, LiveTheme, UserEntity } from '@syra.fm/live';

import { authenticatedClient } from '@/utils/api';
import { API_URL_SOCKET } from '@/config';
import { useIsDesktop } from '@/hooks/useOptimizedMediaQuery';
import { oxyServices } from '@/lib/oxyServices';
import { queryClient } from '@/lib/queryClient';
import { toast } from '@/lib/sonner';
import Avatar from '@/components/Avatar';

/**
 * React Query key for the shared "live rooms" list. Owned here so the Live
 * surface's `useQuery` and the `onRoomChanged` invalidation wired in
 * `AppProviders` key off the exact same tuple — one cache authority for the
 * rooms list.
 */
export const liveRoomsQueryKey = ['live', 'rooms'] as const;

const liveUserQueryKey = (id: string) => ['live', 'user', id] as const;
const LIVE_USER_STALE_TIME = 5 * 60 * 1000;

/**
 * Bloom's `useTheme` returns a superset of the engine's `LiveTheme`. Spreading
 * `colors` into a fresh object literal both forwards every Bloom color key the
 * live-room UI reads AND gives the object the string index signature
 * `LiveTheme.colors` requires (a named interface has none).
 */
function useLiveTheme(): LiveTheme {
  const theme = useTheme();
  return { isDark: theme.isDark, colors: { ...theme.colors } };
}

/**
 * Synchronous cache read of an Oxy user, keyed by id. Reuses the app-wide React
 * Query cache (no bespoke user store) — shares the `liveUserQueryKey` entry that
 * {@link ensureLiveUserById} populates, so a single request feeds both.
 */
function useLiveUserById(id: string | undefined): UserEntity | undefined {
  const { oxyServices: oxy } = useOxy();
  const { data } = useQuery({
    queryKey: liveUserQueryKey(id ?? ''),
    queryFn: async () => (await oxy.getUserById(id ?? '')) ?? null,
    enabled: !!id,
    staleTime: LIVE_USER_STALE_TIME,
  });
  return data ?? undefined;
}

function ensureLiveUserById(
  id: string,
  loader: (id: string) => Promise<UserEntity | null | undefined>,
): Promise<UserEntity | undefined> {
  return queryClient
    .fetchQuery({
      queryKey: liveUserQueryKey(id),
      queryFn: async () => (await loader(id)) ?? null,
      staleTime: LIVE_USER_STALE_TIME,
    })
    .then((user) => user ?? undefined);
}

const liveToast = Object.assign((message: string) => { toast(message); }, {
  success: (message: string) => { toast.success(message); },
  error: (message: string) => { toast.error(message); },
});

/**
 * Dependency-injected configuration for the `@syra.fm/live` engine, mapping every
 * engine seam onto a Syra primitive: the linked Oxy HTTP client, the Syra socket
 * URL, Bloom theming, the app's responsive hook, React Query-backed user
 * resolution, the canonical Oxy file-download resolver, the Syra `Avatar`, and
 * sonner toasts. `onRoomChanged` is injected in `AppProviders` where a
 * `QueryClient` is in scope.
 */
export const liveConfig: LiveConfig = {
  httpClient: authenticatedClient,
  socketUrl: API_URL_SOCKET,
  useTheme: useLiveTheme,
  useIsDesktop,
  useUserById: useLiveUserById,
  ensureUserById: ensureLiveUserById,
  getCachedFileDownloadUrl: async (_oxy, fileId, variant) => oxyServices.getFileDownloadUrl(fileId, variant),
  getCachedFileDownloadUrlSync: (_oxy, fileId, variant) => oxyServices.getFileDownloadUrl(fileId, variant),
  AvatarComponent: Avatar as LiveConfig['AvatarComponent'],
  toast: liveToast,
  introSound: require('@syra.fm/live/src/assets/sounds/intro.mp3'),
};
