/**
 * AppProviders Component
 * Centralizes all provider components for better organization
 * Memoized to prevent unnecessary re-renders
 *
 * ErrorBoundary wraps everything below GestureHandlerRootView so that
 * crashes in any provider (OxyProvider, BottomSheetProvider, etc.) are
 * caught and displayed instead of leaving a blank white screen.
 *
 * BottomSheetModalProvider is required by @gorhom/bottom-sheet v5 for
 * BottomSheetModal to function. Without it, BottomSheetModal crashes on
 * mount, which was causing the white-screen-after-splash bug.
 */

import React, { memo, useCallback, useMemo } from 'react';
import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { MenuProvider } from 'react-native-popup-menu';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider, useOxy } from '@oxyhq/services';
import { OxyServices } from '@oxyhq/core';
import { ImageResolverProvider, type ImageResolver } from '@oxyhq/bloom/image-resolver';
import { LiveConfigProvider, LiveRoomProvider } from '@syra.fm/sdk';

import { OXY_CLIENT_ID } from '@/config';
import ErrorBoundary from '@/components/ErrorBoundary';
import { OfflineBanner } from '@/components/OfflineBanner';
import { BottomSheetProvider } from '@/context/BottomSheetContext';
import { HomeRefreshProvider } from '@/context/HomeRefreshContext';
import { Toaster, toast } from '@/lib/sonner';
import i18n from '@/lib/i18n';
import { usePlayerStore } from '@/stores/playerStore';
import { liveConfig, liveRoomsQueryKey } from '@/lib/liveConfig';
import { useServerAppearanceSync } from '@/hooks/useServerAppearanceSync';
import { usePlayerPresence } from '@/hooks/usePlayerPresence';
import { clearStreamResolutionCache } from '@/services/streamService';
import { accountScopeFor, applyAccountScope, persistOptions } from '@/lib/queryPersister';
import { createScopedLogger } from '@/utils/logger';

const providersLogger = createScopedLogger('AppProviders');

/**
 * Feeds the live-rooms engine and mounts its floating dock. `onRoomChanged` is
 * wired here (not in `liveConfig`) because it needs the in-tree `QueryClient` to
 * invalidate the shared rooms list after a create/join/leave.
 */
function LiveRoomsProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const onRoomChanged = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: liveRoomsQueryKey });
  }, [queryClient]);
  const config = useMemo(() => ({ ...liveConfig, onRoomChanged }), [onRoomChanged]);
  return (
    <LiveConfigProvider config={config}>
      <LiveRoomProvider>{children}</LiveRoomProvider>
    </LiveConfigProvider>
  );
}

/**
 * Non-rendering bridge that pushes the user's saved appearance settings into the
 * Bloom theme. Must live inside both BloomThemeProvider (for `useBloomTheme`)
 * and OxyProvider (for `useAuth`).
 */
function AppearanceSync(): null {
  useServerAppearanceSync();
  return null;
}

/**
 * Non-rendering bridge that opens the Syra Connect `/player` socket, registers
 * this device, and emits heartbeats once authenticated. Must live inside
 * OxyProvider (for `useOxy`).
 */
function PlayerPresence(): null {
  usePlayerPresence();
  return null;
}

/**
 * Non-rendering bridge that turns a failed play into something the listener can
 * actually see.
 *
 * Every play path in the app — cards, rows, the player bar, queue advances,
 * radio — funnels through the player store, so subscribing to its failures once
 * here is what makes all of them report. The alternative, wrapping each of the
 * ~30 call sites, would guarantee the next one added forgets.
 *
 * A failed play is an event rather than a status, so the store stamps each one
 * with a fresh id and this effect fires per failure, not per distinct message.
 * `useTranslation` is safe in a boot-mounted component here only because this
 * app disables i18next suspense explicitly (see `lib/i18n.ts`).
 */
function PlaybackFailureReporter(): null {
  const { t } = useTranslation();
  const { openAccountDialog } = useOxy();
  const failure = usePlayerStore((state) => state.failure);

  React.useEffect(() => {
    if (!failure) {
      return;
    }

    if (failure.reason === 'auth-required') {
      // The backend is the sole entitlement authority and there is no
      // unauthenticated preview endpoint, so signing in is genuinely the only
      // path to audio — say so and open the SDK's in-app sign-in, matching how
      // every other guest-gated action in the app responds.
      toast.info(t('player.errors.signInToListen'));
      openAccountDialog('signin');
      return;
    }

    toast.error(t('player.errors.playbackFailed'));
  }, [failure, t, openAccountDialog]);

  return null;
}

function StreamCacheAuthInvalidator(): null {
  const { oxyServices } = useOxy();

  React.useEffect(() => {
    const unsubscribe = oxyServices.onTokensChanged(() => {
      clearStreamResolutionCache();
    });

    return () => {
      unsubscribe();
    };
  }, [oxyServices]);

  return null;
}

/**
 * Non-rendering bridge that keeps the persisted query cache pointed at the
 * account currently signed in, so one user's library can never rehydrate for
 * the next user on the same device.
 *
 * Driven by the RESOLVED identity rather than by `onTokensChanged`, which also
 * fires on ordinary token refreshes — clearing the cache on those would wipe it
 * constantly. The scope only moves when the account itself changes.
 *
 * The two sources are combined deliberately. A known `user.id` wins outright,
 * even while `canUsePrivateApi` is false, so an account whose token is briefly
 * unusable keeps its own cache instead of being demoted to guest and having its
 * snapshot deleted. Only a finished resolution with no user at all — a real
 * sign-out — moves the scope to guest. While the session is still resolving,
 * nothing happens: an unknown identity must never clear anyone's cache.
 *
 * `isPrivateApiPending` is read directly rather than through `useAuthGate`
 * because the gate's `isResolved` is exactly `!isPrivateApiPending`, and its
 * time bound exists to stop screens rendering endless skeletons. This bridge
 * renders nothing, so the bound would only add a timer: an unresolved session
 * simply leaves the scope untouched, which is already the safe outcome.
 */
function QueryCacheAccountScope(): null {
  const { user, isPrivateApiPending } = useOxy();
  const queryClient = useQueryClient();

  const userId = user?.id ?? null;
  const scope =
    userId !== null ? accountScopeFor(userId) : isPrivateApiPending ? null : accountScopeFor(null);

  React.useEffect(() => {
    if (scope === null) {
      return;
    }
    applyAccountScope(scope, queryClient).catch((error) => {
      providersLogger.error('Failed to apply the account cache scope', { error });
    });
  }, [scope, queryClient]);

  return null;
}

interface AppProvidersProps {
  children: React.ReactNode;
  oxyServices: OxyServices;
  queryClient: QueryClient;
  /**
   * Whether the app shell is mounted. The offline banner anchors itself below
   * the TopBar, so before the shell exists it would hang in empty space over the
   * splash — which reads as a rendering bug rather than a status message.
   */
  isAppReady: boolean;
}

/**
 * Wraps the app with all necessary providers
 * Separated from _layout.tsx for better testability
 * Memoized to prevent re-renders when props don't change
 */
export const AppProviders = memo(function AppProviders({
  children,
  oxyServices,
  queryClient,
  isAppReady,
}: AppProvidersProps) {
  // Single chokepoint that resolves Oxy file IDs to loadable URLs for every
  // Bloom Avatar/Image in the tree. Bloom's Avatar runs bare-string `source`
  // values through this resolver; passing raw file IDs to `source` requires it.
  const resolveImage: ImageResolver = useMemo(
    () => (id: string, variant?: string) => oxyServices.getFileDownloadUrl(id, variant),
    [oxyServices],
  );

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ErrorBoundary>
          <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
            <OxyProvider
              oxyServices={oxyServices}
              clientId={OXY_CLIENT_ID}
              storageKeyPrefix="oxy_syra"
            >
              <ImageResolverProvider value={resolveImage}>
                <I18nextProvider i18n={i18n}>
                  <AppearanceSync />
                  <QueryCacheAccountScope />
                  <StreamCacheAuthInvalidator />
                  <PlaybackFailureReporter />
                  <PlayerPresence />
                  <BottomSheetModalProvider>
                    <BottomSheetProvider>
                      <MenuProvider>
                        <HomeRefreshProvider>
                          <LiveRoomsProvider>
                            {children}
                          </LiveRoomsProvider>
                          <StatusBar style="auto" />
                          {/* Mounted once for the whole app, after `children` so it
                              overlays content, and before `Toaster` so transient
                              toasts still stack above it. */}
                          {isAppReady && <OfflineBanner />}
                          <Toaster
                            position="bottom-center"
                            swipeToDismissDirection="left"
                            offset={15}
                          />
                        </HomeRefreshProvider>
                      </MenuProvider>
                    </BottomSheetProvider>
                  </BottomSheetModalProvider>
                </I18nextProvider>
              </ImageResolverProvider>
            </OxyProvider>
          </PersistQueryClientProvider>
        </ErrorBoundary>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});
