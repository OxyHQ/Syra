// Import Reanimated early to ensure proper initialization before other modules
import 'react-native-reanimated';

import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { Slot } from "expo-router";
import { preventNativeSplashAutoHide, useHideNativeSplashWhenReady } from '@oxyhq/expo-splash';
import React, { useCallback, useEffect, useMemo, useState, memo } from "react";
import { AppState, Platform, StyleSheet, View, type AppStateStatus } from "react-native";

// Components
import AppSplashScreen from '@/components/AppSplashScreen';
import { PlayerBar } from "@/components/PlayerBar";
import { MobilePlayerBar } from "@/components/MobilePlayerBar";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { TopBar, TOP_BAR_HEIGHT } from "@/components/TopBar";
import { LibrarySidebar } from "@/components/LibrarySidebar";
import { NowPlaying } from "@/components/NowPlaying";
import { ThemedView } from "@/components/ThemedView";
import { Panel } from "@/components/Panel";
import { AppProviders } from '@/components/providers/AppProviders';
import { Provider as PortalProvider, Outlet as PortalOutlet } from '@/components/Portal';
import { PLAYER_BAR_HEIGHT } from '@/constants/layout';

// Hooks
import { useKeyboardVisibility } from "@/hooks/useKeyboardVisibility";
import { useIsScreenNotMobile, useIsDesktop } from "@/hooks/useOptimizedMediaQuery";
import { BloomThemeProvider, useTheme } from '@oxyhq/bloom/theme';
import { LayoutScrollProvider, useLayoutScroll } from '@/context/LayoutScrollContext';
import { usePlayerStore } from '@/stores/playerStore';
import { useUIStore } from '@/stores/uiStore';
import { prefetchHomeBrowse } from '@/hooks/useHomeFeed';

// Services & Utils
import { oxyServices } from '@/lib/oxyServices';
import { queryClient } from '@/lib/queryClient';
import { AppInitializer } from '@/lib/appInitializer';
import { webViewStyle, webDimension } from '@/utils/webStyles';
import { createScopedLogger } from '@/utils/logger';

// Styles
import '../styles/global.css';

// NATIVE ONLY: hold the OS splash so it stays visible until the app has finished
// loading fonts + running init, then hide it once `appIsReady` flips (via
// `useHideNativeSplashWhenReady` in RootLayout). This makes the native OS splash
// the SINGLE splash on native — Syra's equalizer logo centered on the dark brand
// background with the Oxy symbol pinned to the bottom (configured by
// `@oxyhq/expo-splash` in app.config.js). The custom `AppSplashScreen` React
// overlay is gated to web only. No-op on web (the shared helper guards
// `Platform.OS === 'web'`).
preventNativeSplashAutoHide();

// Types
interface SplashState {
  initializationComplete: boolean;
  fadeComplete: boolean;
}

interface MainLayoutProps {
  isScreenNotMobile: boolean;
}

const layoutLogger = createScopedLogger('RootLayout');

// NATIVE ONLY: register the LiveKit WebRTC globals the `@syra.fm/sdk` rooms engine
// needs before any room connects. Guarded to native (the browser already has
// WebRTC) and to a soft failure so a missing/unlinked native module never blocks
// app boot for users who don't open a live room.
if (Platform.OS !== 'web') {
  try {
    const { registerGlobals } = require('@livekit/react-native');
    registerGlobals();
  } catch (error) {
    layoutLogger.warn('Failed to register LiveKit globals', { error });
  }
}

/**
 * MainLayout Component
 * Spotify-like 5-panel layout:
 * - Top bar (always visible)
 * - Left sidebar (Your Library - collapsible)
 * - Main content area (flexible, scrollable)
 * - Right sidebar (artist/album details - collapsible, desktop only)
 * - Bottom player bar (always visible, fixed position)
 */
const MainLayout: React.FC<MainLayoutProps> = memo(({ isScreenNotMobile }) => {
  const theme = useTheme();
  const { forwardWheelEvent } = useLayoutScroll();
  const isDesktop = useIsDesktop();
  const keyboardVisible = useKeyboardVisibility();
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const currentEpisode = usePlayerStore(s => s.currentEpisode);
  const hasNowPlaying = !!currentTrack || !!currentEpisode;
  const fullscreenPanel = useUIStore(s => s.fullscreenPanel);
  const isLibrarySidebarExpanded = useUIStore(s => s.isLibrarySidebarExpanded);
  const isLibraryFullscreen = fullscreenPanel === 'library';
  const isNowPlayingFullscreen = fullscreenPanel === 'nowPlaying';
  const showNowPlayingPanel = isDesktop && !isLibraryFullscreen && (isNowPlayingFullscreen || hasNowPlaying);

  // On mobile, no gaps or padding
  const gapSize = isScreenNotMobile ? 12 : 0;
  const outerPadding = isScreenNotMobile ? 12 : 0;

  // Calculate panel height for web - all panels should have same height
  // On desktop, player bar is outside panels wrapper in normal flow, so we subtract it from height
  // Player bar uses padding-based sizing (~92px: 4px progress + 16px top + 56px content + 16px bottom)
  // Padding is on panelsWrapper (bottom only, no top padding), so we subtract outerPadding
  // On mobile, player bar is absolute/fixed, so it doesn't affect height calculation
  // topbar + playerBar (~92px) + padding (bottom only on desktop). These are
  // web `calc()` strings; native panels do not use this height (they flex, so
  // the top safe-area inset that grows the TopBar on native is absorbed
  // automatically). On web `insets.top` is 0, so `TOP_BAR_HEIGHT` is exact.
  const NOW_PLAYING_WIDTH = 360;
  const LIBRARY_WIDTH_EXPANDED = 320;
  const LIBRARY_WIDTH_COLLAPSED = 72;
  const librarySidebarWidth = isLibrarySidebarExpanded ? LIBRARY_WIDTH_EXPANDED : LIBRARY_WIDTH_COLLAPSED;
  const panelHeight = webDimension(
    isScreenNotMobile
      ? `calc(100vh - ${TOP_BAR_HEIGHT}px - ${PLAYER_BAR_HEIGHT}px - ${outerPadding}px)`
      : `calc(100vh - ${TOP_BAR_HEIGHT}px - ${PLAYER_BAR_HEIGHT}px)`
  );

  const styles = useMemo(() => StyleSheet.create({
    outerContainer: {
      flex: 1,
      width: '100%',
      backgroundColor: theme.colors.background,
    },
    contentWrapper: {
      flex: 1,
    },
    topBarContainer: webViewStyle({
      zIndex: 1000,
      ...(Platform.OS === 'web' && isScreenNotMobile
        ? {
          position: 'sticky' as const,
          top: 0,
        }
        : {}),
    }),
    panelsWrapper: {
      flex: 1,
      flexDirection: isScreenNotMobile ? 'row' : 'column',
      ...Platform.select({
        web: isScreenNotMobile ? {
          paddingLeft: outerPadding,
          paddingRight: outerPadding,
          paddingBottom: outerPadding,
          gap: gapSize, // Consistent gap between panels
        } : {},
      }),
    },
    leftSidebarContainer: {
      flexShrink: 0,
      flexGrow: isLibraryFullscreen ? 1 : 0,
      width: isLibraryFullscreen ? undefined : librarySidebarWidth,
      ...Platform.select({
        web: {
          height: panelHeight,
        },
      }),
    },
    mainContentWrapper: webViewStyle({
      flex: 1,
      minWidth: 0, // Allow flexbox to shrink below content size
      ...Platform.select({
        web: {
          overflowY: 'auto',
          height: panelHeight,
        },
      }),
    }),
    rightSidebarContainer: {
      flexShrink: 0,
      flexGrow: isNowPlayingFullscreen ? 1 : 0,
      // Fixed width in sidebar state; undefined in fullscreen so flexGrow fills.
      width: isNowPlayingFullscreen ? undefined : NOW_PLAYING_WIDTH,
      ...Platform.select({
        web: {
          height: panelHeight,
        },
      }),
    },
    playerBarContainer: {
      // Desktop only - mobile player bar handles its own positioning
    },
  }), [isScreenNotMobile, theme.colors.background, gapSize, outerPadding, panelHeight, isLibraryFullscreen, isNowPlayingFullscreen, librarySidebarWidth]);

  const handleWheel = useCallback((event: Parameters<typeof forwardWheelEvent>[0]) => {
    forwardWheelEvent(event);
  }, [forwardWheelEvent]);

  const containerProps = useMemo(
    () => (Platform.OS === 'web' ? { onWheel: handleWheel } : {}),
    [handleWheel]
  );

  return (
    <View style={styles.outerContainer} {...containerProps}>
      {/* Top Navigation Bar - Outside panels wrapper */}
      <View style={styles.topBarContainer}>
        <TopBar />
      </View>

      {/* Content Wrapper - Only panels */}
      <View style={styles.contentWrapper}>
        {/* Panels Wrapper - All panels with same height and rounded corners, padding applied here */}
        <View style={styles.panelsWrapper}>
          {/* Left Sidebar - Your Library */}
          {isScreenNotMobile && !isNowPlayingFullscreen && (
            <Panel rounded="all" radius={12} style={styles.leftSidebarContainer}>
              <LibrarySidebar />
            </Panel>
          )}

          {/* Main Content */}
          {!isLibraryFullscreen && !isNowPlayingFullscreen && (
            <Panel rounded="all" radius={12} style={styles.mainContentWrapper}>
              <Slot />
            </Panel>
          )}

          {/* Right Sidebar - Artist/Album Details (Desktop only) */}
          {showNowPlayingPanel && (
            <Panel rounded="all" radius={12} style={styles.rightSidebarContainer}>
              <NowPlaying />
            </Panel>
          )}
        </View>
      </View>

      {/* Bottom Player Bar - Outside panels wrapper */}
      {!keyboardVisible && (
        <>
          {isScreenNotMobile ? (
            <View style={styles.playerBarContainer}>
              <PlayerBar />
            </View>
          ) : (
            // Mobile: Only show player bar when there's a track or episode playing
            hasNowPlaying && <MobilePlayerBar />
          )}
        </>
      )}

      {/* Mobile Bottom Navigation - Only on mobile */}
      {!isScreenNotMobile && !keyboardVisible && <MobileBottomNav />}
    </View>
  );
});

MainLayout.displayName = 'MainLayout';

export default function RootLayout() {
  // State — only the two inputs are stored; `startFade` and `appIsReady` are derived.
  const [splashState, setSplashState] = useState<SplashState>({
    initializationComplete: false,
    fadeComplete: false,
  });

  // The splash begins fading the moment initialization completes, and the app is
  // ready once init AND the fade-out have both finished. Deriving these avoids
  // setState-in-effect cascades.
  //
  // Readiness is PLATFORM-AWARE:
  // - WEB renders the custom <AppSplashScreen>, which fades out when init
  //   completes and calls `onFadeComplete` (→ `fadeComplete`). So web readiness =
  //   init complete AND the custom splash finished fading.
  // - NATIVE renders NO custom splash (the held OS splash covers the screen), so
  //   `onFadeComplete` never fires. Native readiness = init complete ALONE — else
  //   `appIsReady` would never flip and the held OS splash would hang forever.
  const startFade = splashState.initializationComplete;
  const appIsReady =
    Platform.OS === 'web'
      ? splashState.initializationComplete && splashState.fadeComplete
      : splashState.initializationComplete;

  // Hooks
  const isScreenNotMobile = useIsScreenNotMobile();
  const keyboardVisible = useKeyboardVisibility();

  // Font loading is owned entirely by Bloom's `BloomThemeProvider`/`FontLoader`:
  // it loads the Bloom font families on native (and sets the default `Text`
  // family) and injects the `@font-face` rules + `--bloom-font-*` tokens on web.
  // The provider gates native rendering on fonts via its `onFontsLoading`
  // fallback (wired below), so this layout no longer loads fonts itself.

  // Callbacks
  const handleSplashFadeComplete = useCallback(() => {
    setSplashState((prev) => ({ ...prev, fadeComplete: true }));
  }, []);

  // NATIVE ONLY: once the app is ready, hide the held OS splash. The shared helper
  // is a no-op on web (the OS splash was never held; the custom overlay handles
  // the transition there).
  useHideNativeSplashWhenReady(appIsReady);

  // Initialize i18n once when the app mounts
  useEffect(() => {
    AppInitializer.initializeI18n().catch((error) => {
      layoutLogger.error('Failed to initialize i18n', { error });
    });
  }, []);

  // Load eager settings that don't block app initialization
  useEffect(() => {
    AppInitializer.loadEagerSettings();
    prefetchHomeBrowse(queryClient);
  }, [queryClient]);

  // React Query managers - setup once on mount
  useEffect(() => {
    // React Query online manager using NetInfo
    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      onlineManager.setOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
    });

    // React Query focus manager using AppState.
    // This is load-bearing even though `refetchOnWindowFocus` is false: query-core
    // gates `refetchInterval` on `focusManager.isFocused()` unless a query sets
    // `refetchIntervalInBackground`, and the polling search queries in TopBar.tsx
    // and app/search.tsx deliberately leave that false. React Native has no
    // window-focus event, so without this wiring those polls would never pause
    // while the app is backgrounded. Do not remove it as dead code.
    const onAppStateChange = (status: AppStateStatus) => {
      focusManager.setFocused(status === 'active');
    };
    const appStateSub = AppState.addEventListener('change', onAppStateChange);

    return () => {
      unsubscribeNetInfo();
      appStateSub.remove();
    };
  }, []); // Empty deps - setup once

  // Run app initialization once on mount. The state update happens only after the
  // awaited bootstrap resolves, so it is not a synchronous in-effect setState.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const result = await AppInitializer.initializeApp(true);
      if (cancelled) return;
      if (!result.success) {
        layoutLogger.error('App initialization failed', { error: result.error });
      }
      // Mark complete on success OR failure to avoid blocking the app on the splash.
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  // Memoize app content to prevent unnecessary re-renders
  const appContent = useMemo(() => {
    return (
      <AppProviders
        oxyServices={oxyServices}
        queryClient={queryClient}
        isAppReady={appIsReady}
      >
        {appIsReady ? (
          <>
            {/* Portal Provider for rendering components outside tree */}
            <PortalProvider>
              <LayoutScrollProvider>
                <MainLayout isScreenNotMobile={isScreenNotMobile} />
                <PortalOutlet />
              </LayoutScrollProvider>
            </PortalProvider>
          </>
        ) : Platform.OS === 'web' ? (
          // WEB: the custom splash covers font-load + init and fades out; its
          // `onFadeComplete` gates `appIsReady`. NATIVE renders null here — the
          // held OS splash is on top, so nothing underneath needs to paint.
          <AppSplashScreen
            startFade={startFade}
            onFadeComplete={handleSplashFadeComplete}
          />
        ) : null}
      </AppProviders>
    );
  }, [
    appIsReady,
    startFade,
    isScreenNotMobile,
    keyboardVisible,
    handleSplashFadeComplete,
    // oxyServices is stable (imported singleton), but included for completeness
  ]);

  return (
    <BloomThemeProvider
      defaultMode="dark"
      defaultColorPreset="purple"
      // WEB shows the custom splash while fonts load; NATIVE shows nothing here
      // because the held OS splash is already covering the screen.
      onFontsLoading={Platform.OS === 'web' ? <AppSplashScreen /> : null}
      // App-wide dynamic ambient theming is owned entirely by Bloom: the hover/view
      // sites call `useAmbientTheme().setAmbient(...)`/`clearAmbient()` and the
      // provider consumes that store internally — no `seed` prop threading here.
    >
      <ThemedView style={{ flex: 1 }}>
        {appContent}
      </ThemedView>
    </BloomThemeProvider>
  );
}
