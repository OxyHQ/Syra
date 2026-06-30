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

import React, { memo, useMemo } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { I18nextProvider } from 'react-i18next';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { MenuProvider } from 'react-native-popup-menu';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider, useOxy } from '@oxyhq/services';
import { OxyServices } from '@oxyhq/core';
import { ImageResolverProvider, type ImageResolver } from '@oxyhq/bloom/image-resolver';

import { OXY_CLIENT_ID } from '@/config';
import ErrorBoundary from '@/components/ErrorBoundary';
import { BottomSheetProvider } from '@/context/BottomSheetContext';
import { HomeRefreshProvider } from '@/context/HomeRefreshContext';
import { Toaster } from '@/lib/sonner';
import i18n from '@/lib/i18n';
import { useServerAppearanceSync } from '@/hooks/useServerAppearanceSync';
import { clearStreamResolutionCache } from '@/services/streamService';
import { persistOptions } from '@/lib/queryPersister';

/**
 * Non-rendering bridge that pushes the user's saved appearance settings into the
 * Bloom theme. Must live inside both BloomThemeProvider (for `useBloomTheme`)
 * and OxyProvider (for `useAuth`).
 */
function AppearanceSync(): null {
  useServerAppearanceSync();
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

interface AppProvidersProps {
  children: React.ReactNode;
  oxyServices: OxyServices;
  queryClient: QueryClient;
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
                  <StreamCacheAuthInvalidator />
                  <BottomSheetModalProvider>
                    <BottomSheetProvider>
                      <MenuProvider>
                        <HomeRefreshProvider>
                          {children}
                          <StatusBar style="auto" />
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
