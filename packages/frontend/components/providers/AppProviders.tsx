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

import React, { memo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { MenuProvider } from 'react-native-popup-menu';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider } from '@oxyhq/services';
import { OxyServices } from '@oxyhq/core';

import ErrorBoundary from '@/components/ErrorBoundary';
import { BottomSheetProvider } from '@/context/BottomSheetContext';
import { HomeRefreshProvider } from '@/context/HomeRefreshContext';
import { Toaster } from '@/lib/sonner';
import i18n from '@/lib/i18n';

interface AppProvidersProps {
  children: React.ReactNode;
  oxyServices: OxyServices;
  colorScheme: 'light' | 'dark' | null | undefined;
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
  colorScheme,
  queryClient,
}: AppProvidersProps) {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <OxyProvider
              oxyServices={oxyServices}
              storageKeyPrefix="oxy_syra"
            >
              <I18nextProvider i18n={i18n}>
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
            </OxyProvider>
          </QueryClientProvider>
        </ErrorBoundary>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});

