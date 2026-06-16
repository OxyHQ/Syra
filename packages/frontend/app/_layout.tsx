// Import Reanimated early to ensure proper initialization before other modules
import 'react-native-reanimated';

import NetInfo from '@react-native-community/netinfo';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import { Slot } from "expo-router";
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
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';
import { Provider as PortalProvider, Outlet as PortalOutlet } from '@/components/Portal';
import { PLAYER_BAR_HEIGHT } from '@/constants/layout';

// Hooks
import { useKeyboardVisibility } from "@/hooks/useKeyboardVisibility";
import { useIsScreenNotMobile, useIsDesktop } from "@/hooks/useOptimizedMediaQuery";
import { BloomThemeProvider, useTheme } from '@oxyhq/bloom/theme';
import { LayoutScrollProvider, useLayoutScroll } from '@/context/LayoutScrollContext';
import { usePlayerStore } from '@/stores/playerStore';
import { useUIStore } from '@/stores/uiStore';

// Services & Utils
import { oxyServices } from '@/lib/oxyServices';
import { AppInitializer } from '@/lib/appInitializer';
import { webViewStyle, webDimension } from '@/utils/webStyles';

// Styles
import '../styles/global.css';

// Types
interface SplashState {
  initializationComplete: boolean;
  startFade: boolean;
  fadeComplete: boolean;
}

interface MainLayoutProps {
  isScreenNotMobile: boolean;
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
  const { currentTrack } = usePlayerStore();
  const { fullscreenPanel } = useUIStore();
  const isLibraryFullscreen = fullscreenPanel === 'library';
  const isNowPlayingFullscreen = fullscreenPanel === 'nowPlaying';

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
      ...Platform.select({
        web: {
          position: 'sticky',
          top: 0,
          zIndex: 1000,
        },
      }),
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
  }), [isScreenNotMobile, isDesktop, theme.colors.background, gapSize, outerPadding, panelHeight, isLibraryFullscreen, isNowPlayingFullscreen]);

  const handleWheel = useCallback((event: any) => {
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
          {isDesktop && !isLibraryFullscreen && (
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
            // Mobile: Only show player bar when there's a track playing
            currentTrack && <MobilePlayerBar />
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
  // State
  const [appIsReady, setAppIsReady] = useState(false);
  const [splashState, setSplashState] = useState<SplashState>({
    initializationComplete: false,
    startFade: false,
    fadeComplete: false,
  });

  // Hooks
  const isScreenNotMobile = useIsScreenNotMobile();
  const keyboardVisible = useKeyboardVisibility();

  // Memoized instances
  const queryClient = useMemo(() => new QueryClient(QUERY_CLIENT_CONFIG), []);

  // Font loading is owned entirely by Bloom's `BloomThemeProvider`/`FontLoader`:
  // it loads the Bloom font families on native (and sets the default `Text`
  // family) and injects the `@font-face` rules + `--bloom-font-*` tokens on web.
  // The provider gates native rendering on fonts via its `onFontsLoading`
  // fallback (wired below), so this layout no longer loads fonts itself.

  // Callbacks
  const handleSplashFadeComplete = useCallback(() => {
    setSplashState((prev) => ({ ...prev, fadeComplete: true }));
  }, []);

  const initializeApp = useCallback(async () => {
    const result = await AppInitializer.initializeApp(true, oxyServices);

    if (result.success) {
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    } else {
      console.error('App initialization failed:', result.error);
      // Still mark as complete to prevent blocking the app
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    }
  }, []);


  // Initialize i18n once when the app mounts
  useEffect(() => {
    AppInitializer.initializeI18n().catch((error) => {
      console.error('Failed to initialize i18n:', error);
    });
  }, []);

  // Load eager settings that don't block app initialization
  useEffect(() => {
    AppInitializer.loadEagerSettings(oxyServices);
  }, []);

  // React Query managers - setup once on mount
  useEffect(() => {
    // React Query online manager using NetInfo
    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      onlineManager.setOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
    });

    // React Query focus manager using AppState
    const onAppStateChange = (status: AppStateStatus) => {
      focusManager.setFocused(status === 'active');
    };
    const appStateSub = AppState.addEventListener('change', onAppStateChange);

    return () => {
      unsubscribeNetInfo();
      appStateSub.remove();
    };
  }, []); // Empty deps - setup once

  useEffect(() => {
    initializeApp();
  }, [initializeApp]);

  useEffect(() => {
    if (splashState.initializationComplete && !splashState.startFade) {
      setSplashState((prev) => ({ ...prev, startFade: true }));
    }
  }, [splashState.initializationComplete, splashState.startFade]);

  // Set appIsReady only after both initialization (including auth) and splash fade complete
  useEffect(() => {
    if (splashState.initializationComplete && splashState.fadeComplete && !appIsReady) {
      setAppIsReady(true);
    }
  }, [splashState.initializationComplete, splashState.fadeComplete, appIsReady]);

  // Memoize app content to prevent unnecessary re-renders
  const appContent = useMemo(() => {
    if (!appIsReady) {
      return (
        <AppSplashScreen
          startFade={splashState.startFade}
          onFadeComplete={handleSplashFadeComplete}
        />
      );
    }

    return (
      <AppProviders
        oxyServices={oxyServices}
        queryClient={queryClient}
      >
        {/* Portal Provider for rendering components outside tree */}
        <PortalProvider>
          <LayoutScrollProvider>
            <MainLayout isScreenNotMobile={isScreenNotMobile} />
            <PortalOutlet />
          </LayoutScrollProvider>
        </PortalProvider>
      </AppProviders>
    );
  }, [
    appIsReady,
    splashState.startFade,
    splashState.initializationComplete,
    splashState.fadeComplete,
    isScreenNotMobile,
    keyboardVisible,
    handleSplashFadeComplete,
    queryClient,
    // oxyServices is stable (imported singleton), but included for completeness
  ]);

  return (
    <BloomThemeProvider
      defaultMode="dark"
      defaultColorPreset="purple"
      onFontsLoading={<AppSplashScreen />}
    >
      <ThemedView style={{ flex: 1 }}>
        {appContent}
      </ThemedView>
    </BloomThemeProvider>
  );
}
