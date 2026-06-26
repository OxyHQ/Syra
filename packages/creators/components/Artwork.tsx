import { View } from 'react-native';
import { Image } from 'expo-image';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { cn } from '@/lib/utils';

/**
 * Podcast/episode cover art. Podcast artwork is an external absolute URL
 * (mirrored from the source feed or set by the creator), so it renders directly
 * — never through the Oxy media resolver. Falls back to a themed placeholder.
 */
export function Artwork({
  uri,
  size = 56,
  rounded = 'lg',
}: {
  uri?: string | null;
  size?: number;
  rounded?: 'lg' | 'xl' | '2xl';
}) {
  const theme = useTheme();
  const radiusClass = rounded === '2xl' ? 'rounded-2xl' : rounded === 'xl' ? 'rounded-xl' : 'rounded-lg';

  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size }}
        className={cn(radiusClass, 'bg-surface')}
        contentFit="cover"
        transition={150}
      />
    );
  }

  return (
    <View
      style={{ width: size, height: size }}
      className={cn(radiusClass, 'bg-surface items-center justify-center')}
    >
      <MaterialCommunityIcons name="podcast" size={size * 0.45} color={theme.colors.textSecondary} />
    </View>
  );
}
