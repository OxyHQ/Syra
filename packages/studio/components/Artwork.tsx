import { Platform, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { createTokenStyles, useTheme } from '@oxy.so/bloom/theme';

type ArtworkRadius = 'lg' | 'xl' | '2xl';

// Syra's theme: `rounded-lg` is `--radius` (1rem), `rounded-xl` Tailwind's 0.75rem,
// `rounded-2xl` 1rem.
const radii = StyleSheet.create({
  lg: { borderRadius: 16 },
  xl: { borderRadius: 12 },
  '2xl': { borderRadius: 16 },
});

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
  rounded?: ArtworkRadius;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const box = { width: size, height: size };

  if (uri) {
    return (
      <Image
        source={{ uri }}
        // expo-image's native view never read a class: only the web drew the
        // radius and the surface behind the image, so only the web gets them.
        style={[box, Platform.OS === 'web' && [radii[rounded], styles.surface]]}
        contentFit="cover"
        transition={150}
      />
    );
  }

  return (
    <View style={[box, radii[rounded], styles.placeholder]}>
      <MaterialCommunityIcons
        name="podcast"
        size={size * 0.45}
        color={theme.colors.textSecondary}
      />
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  surface: { backgroundColor: t.surface },
  placeholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface },
}));
