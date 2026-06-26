import { Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';

/**
 * Placeholder for the future music-artist studio (uploads, releases, insights —
 * Spotify-for-Artists style). The nav slot exists today; the surface ships later.
 */
function MusicStudioPlaceholder() {
  const theme = useTheme();
  return (
    <ScreenContainer title="Music" subtitle="For artists">
      <View className="items-center justify-center py-20 px-6">
        <View className="w-16 h-16 rounded-2xl bg-primary/10 items-center justify-center mb-4">
          <MaterialCommunityIcons name="music" size={30} color={theme.colors.primary} />
        </View>
        <Text className="text-lg font-semibold text-foreground mb-1">Music studio is coming</Text>
        <Text className="text-sm text-muted-foreground text-center max-w-[360px]">
          Soon you&apos;ll upload tracks, manage releases, and see listener insights here — right alongside your
          podcasts.
        </Text>
      </View>
    </ScreenContainer>
  );
}

export default function MusicScreen() {
  return (
    <SignInGate>
      <MusicStudioPlaceholder />
    </SignInGate>
  );
}
