import { Text, View } from 'react-native';
import { Link, Stack } from 'expo-router';
import { createTokenStyles } from '@oxy.so/bloom/theme';

export default function NotFoundScreen() {
  const styles = useStyles();
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <View style={styles.centered}>
        <Text style={styles.title}>Page not found</Text>
        <Text style={styles.mutedText}>This screen doesn&apos;t exist in Syra Studio.</Text>
        <Link href="/" className="text-primary font-semibold text-base">
          Go to dashboard
        </Link>
      </View>
    </>
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
    paddingHorizontal: 24,
  },
  title: { marginBottom: 8, fontSize: 24, fontWeight: 700, color: t.foreground, lineHeight: 32 },
  mutedText: {
    marginBottom: 24,
    textAlign: 'center',
    fontSize: 14,
    color: t.mutedForeground,
    lineHeight: 20,
  },
}));
