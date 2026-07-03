// Import Reanimated early so it initializes before other modules (Bloom peer).
import 'react-native-reanimated';

import { Slot } from 'expo-router';
import { Platform, View } from 'react-native';
import { BloomThemeProvider } from '@oxyhq/bloom/theme';

import { createScopedLogger } from '@/utils/logger';

// NATIVE ONLY: register the LiveKit WebRTC globals the `@syra.fm/live` rooms engine
// needs before any room connects. Guarded to native (the browser already has
// WebRTC) and to a soft failure so a missing/unlinked native module never blocks
// app boot for creators who never go live.
if (Platform.OS !== 'web') {
  try {
    const { registerGlobals } = require('@livekit/react-native');
    registerGlobals();
  } catch (error) {
    createScopedLogger('RootLayout').warn('Failed to register LiveKit globals', { error });
  }
}

import { AppProviders } from '@/components/providers/AppProviders';
import { AppShell } from '@/components/AppShell';
import SplashScreen from '@/components/SplashScreen';
import { oxyServices } from '@/lib/oxyServices';
import { queryClient } from '@/lib/queryClient';

import '../styles/global.css';

/**
 * Root layout.
 *
 * `BloomThemeProvider` is hoisted to the very top so it wraps EVERY render
 * branch — including the font-loading splash it renders via `onFontsLoading`
 * and the full provider/app tree below. Anything that calls `useTheme()` (the
 * splash, the shell, every screen) is therefore always inside the provider,
 * which avoids the "useTheme must be used within a <BloomThemeProvider>" crash.
 */
export default function RootLayout() {
  return (
    <BloomThemeProvider
      defaultMode="dark"
      defaultColorPreset="purple"
      onFontsLoading={<SplashScreen />}
    >
      <View className="flex-1 bg-background">
        <AppProviders oxyServices={oxyServices} queryClient={queryClient}>
          <AppShell>
            <Slot />
          </AppShell>
        </AppProviders>
      </View>
    </BloomThemeProvider>
  );
}
