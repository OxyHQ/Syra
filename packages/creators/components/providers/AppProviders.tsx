/**
 * AppProviders
 * Centralizes the provider stack for the creator studio.
 *
 * ErrorBoundary wraps everything below GestureHandlerRootView so a crash in any
 * provider (OxyProvider, BottomSheetModalProvider, etc.) renders the fallback
 * instead of a blank screen. BottomSheetModalProvider is required by
 * @gorhom/bottom-sheet v5 (the Oxy auth/account sheets mount through it).
 */

import { memo, useMemo, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider } from '@oxyhq/services';
import type { OxyServices } from '@oxyhq/core';
import { ImageResolverProvider, type ImageResolver } from '@oxyhq/bloom/image-resolver';

import { OXY_CLIENT_ID } from '@/config';
import ErrorBoundary from '@/components/ErrorBoundary';
import { Toaster } from '@/lib/sonner';

interface AppProvidersProps {
  children: ReactNode;
  oxyServices: OxyServices;
  queryClient: QueryClient;
}

export const AppProviders = memo(function AppProviders({
  children,
  oxyServices,
  queryClient,
}: AppProvidersProps) {
  // Single chokepoint that resolves Oxy file IDs to loadable URLs for every
  // Bloom Avatar/Image in the tree. External podcast artwork (absolute URLs) is
  // rendered directly and never routed through this resolver.
  const resolveImage: ImageResolver = useMemo(
    () => (id: string, variant?: string) => oxyServices.getFileDownloadUrl(id, variant),
    [oxyServices],
  );

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <OxyProvider
              oxyServices={oxyServices}
              clientId={OXY_CLIENT_ID}
              storageKeyPrefix="oxy_syra_creators"
            >
              <ImageResolverProvider value={resolveImage}>
                <BottomSheetModalProvider>
                  {children}
                  <StatusBar style="auto" />
                  <Toaster position="bottom-center" swipeToDismissDirection="left" offset={15} />
                </BottomSheetModalProvider>
              </ImageResolverProvider>
            </OxyProvider>
          </QueryClientProvider>
        </ErrorBoundary>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});
