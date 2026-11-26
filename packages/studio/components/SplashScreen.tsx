import { ActivityIndicator, View } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { createTokenStyles } from '@oxy.so/bloom/theme';

/**
 * Minimal splash/loading surface shown while the app boots and Bloom loads its
 * fonts. Rendered inside `BloomThemeProvider`, so `useTheme()` is always safe.
 */
export default function SplashScreen() {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.centered}>
      <ActivityIndicator size="large" color={theme.colors.primary} />
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  centered: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.background,
  },
}));
