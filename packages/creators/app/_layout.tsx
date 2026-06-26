// Import Reanimated early so it initializes before other modules (Bloom peer).
import 'react-native-reanimated';

import { Slot } from 'expo-router';
import { View } from 'react-native';
import { BloomThemeProvider } from '@oxyhq/bloom/theme';

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
