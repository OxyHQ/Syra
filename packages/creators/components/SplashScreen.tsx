import { ActivityIndicator, View } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';

/**
 * Minimal splash/loading surface shown while the app boots and Bloom loads its
 * fonts. Rendered inside `BloomThemeProvider`, so `useTheme()` is always safe.
 */
export default function SplashScreen() {
  const theme = useTheme();
  return (
    <View className="flex-1 items-center justify-center bg-background">
      <ActivityIndicator size="large" color={theme.colors.primary} />
    </View>
  );
}
