// Import Reanimated early to ensure proper initialization before other modules
import 'react-native-reanimated';

import NetInfo from '@react-native-community/netinfo';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import { useFonts } from "expo-font";
import { Slot } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState, memo } from "react";
import { AppState, Platform, StyleSheet, Text, TextInput, View, type AppStateStatus } from "react-native";

// Components
import AppSplashScreen from '@/components/AppSplashScreen';
import { PlayerBar } from "@/components/PlayerBar";
import { MobilePlayerBar } from "@/components/MobilePlayerBar";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { TopBar } from "@/components/TopBar";
import { LibrarySidebar } from "@/components/LibrarySidebar";
import { NowPlaying } from "@/components/NowPlaying";
import { ThemedView } from "@/components/ThemedView";
import { Panel } from "@/components/Panel";
import { AppProviders } from '@/components/providers/AppProviders';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';
import { Provider as PortalProvider, Outlet as PortalOutlet } from '@/components/Portal';

// Hooks
import { useColorScheme } from "@/hooks/useColorScheme";
import { useKeyboardVisibility } from "@/hooks/useKeyboardVisibility";
import { useIsScreenNotMobile, useIsDesktop } from "@/hooks/useOptimizedMediaQuery";
import { useTheme } from '@/hooks/useTheme';
import { LayoutScrollProvider, useLayoutScroll } from '@/context/LayoutScrollContext';
import { usePlayerStore } from '@/stores/playerStore';
import { useUIStore } from '@/stores/uiStore';

// Services & Utils
import { oxyServices } from '@/lib/oxyServices';
import { AppInitializer } from '@/lib/appInitializer';

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
  const panelHeight = isScreenNotMobile
    ? `calc(100vh - 64px - 92px - ${outerPadding}px)` as any // topbar + playerBar (~92px) + padding (bottom only)
    : `calc(100vh - 64px - 92px)` as any; // topbar + playerBar (~92px, absolute positioned)

  const styles = useMemo(() => StyleSheet.create({
    outerContainer: {
      flex: 1,
      width: '100%',
      backgroundColor: '#000000', // Black app background
    },
    contentWrapper: {
      flex: 1,
    },
    topBarContainer: {
      ...Platform.select({
        web: {
          position: 'sticky' as any,
          top: 0,
          zIndex: 1000,
        },
      }),
    },
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
    mainContentWrapper: {
      flex: 1,
      minWidth: 0, // Allow flexbox to shrink below content size
      ...Platform.select({
        web: {
          overflowY: 'auto' as any,
          height: panelHeight,
        },
      }),
    },
    rightSidebarContainer: {
      flexShrink: 0,
      flexGrow: isNowPlayingFullscreen ? 1 : 0,
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

  // Font Loading
  // Optimized: Using variable fonts - single file per family contains all weights
  // This reduces loading overhead significantly compared to registering each weight separately
  const [fontsLoaded, fontError] = useFonts(
    useMemo(() => {
      const fontMap: Record<string, any> = {};
      const InterVariable = require('@/assets/fonts/inter/InterVariable.ttf');
      const PhuduVariable = require('@/assets/fonts/Phudu-VariableFont_wght.ttf');

      // Inter: Single variable font with weight aliases
      ['Thin', 'ExtraLight', 'Light', 'Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Black'].forEach(weight => {
        fontMap[`Inter-${weight}`] = InterVariable;
      });

      // Phudu: Single variable font with weight aliases
      ['Thin', 'Regular', 'Medium', 'SemiBold', 'Bold'].forEach(weight => {
        fontMap[`Phudu-${weight}`] = PhuduVariable;
      });

      return fontMap;
    }, [])
  );

  // If font loading fails (e.g. corrupt file, 404, wrong format), log the error
  // and treat fonts as "ready" so the app doesn't stay stuck on splash.
  const [fontTimedOut, setFontTimedOut] = useState(false);
  const fontsReady = fontsLoaded || !!fontError || fontTimedOut;

  useEffect(() => {
    if (fontError) {
      console.error('Font loading failed, proceeding without custom fonts', fontError);
    }
  }, [fontError]);

  // Safety timeout: if fonts haven't loaded after 5 seconds, proceed anyway
  useEffect(() => {
    if (fontsReady) return;
    const timer = setTimeout(() => {
      console.warn('Font loading timed out after 5s, proceeding without custom fonts');
      setFontTimedOut(true);
    }, 5000);
    return () => clearTimeout(timer);
  }, [fontsReady]);

  // Set Inter as the default font for all Text and TextInput components
  useEffect(() => {
    if (!fontsLoaded) return;
    const defaultTextStyle = { fontFamily: 'Inter-Regular' };
    const textProps = (Text as any).defaultProps || {};
    (Text as any).defaultProps = {
      ...textProps,
      style: [textProps.style, defaultTextStyle],
    };
    const textInputProps = (TextInput as any).defaultProps || {};
    (TextInput as any).defaultProps = {
      ...textInputProps,
      style: [textInputProps.style, defaultTextStyle],
    };
  }, [fontsLoaded]);

  // Callbacks
  const handleSplashFadeComplete = useCallback(() => {
    setSplashState((prev) => ({ ...prev, fadeComplete: true }));
  }, []);

  const initializeApp = useCallback(async () => {
    if (!fontsReady) return;

    const result = await AppInitializer.initializeApp(fontsReady, oxyServices);

    if (result.success) {
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    } else {
      console.error('App initialization failed:', result.error);
      // Still mark as complete to prevent blocking the app
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    }
  }, [fontsReady]);


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
    if (fontsReady && splashState.initializationComplete && !splashState.startFade) {
      setSplashState((prev) => ({ ...prev, startFade: true }));
    }
  }, [fontsReady, splashState.initializationComplete, splashState.startFade]);

  // Set appIsReady only after both initialization (including auth) and splash fade complete
  useEffect(() => {
    if (splashState.initializationComplete && splashState.fadeComplete && !appIsReady) {
      setAppIsReady(true);
    }
  }, [splashState.initializationComplete, splashState.fadeComplete, appIsReady]);

  const theme = useTheme();
  const colorScheme = useColorScheme();

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
        colorScheme={colorScheme}
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
    colorScheme,
    isScreenNotMobile,
    keyboardVisible,
    handleSplashFadeComplete,
    queryClient,
    // oxyServices is stable (imported singleton), but included for completeness
  ]);

  return (
    <ThemedView style={{ flex: 1 }}>
      {appContent}
    </ThemedView>
  );
}
