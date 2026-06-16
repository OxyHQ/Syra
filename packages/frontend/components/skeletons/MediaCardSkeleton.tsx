import React from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { webViewStyle } from '@/utils/webStyles';

interface MediaCardSkeletonProps {
  /** `circle` mirrors artist cards; `square` mirrors albums/playlists/tracks. */
  shape?: 'square' | 'circle';
}

/**
 * Loading placeholder mirroring {@link MediaCard}: a square (or circular)
 * cover image followed by a title line and a shorter subtitle line.
 */
export const MediaCardSkeleton: React.FC<MediaCardSkeletonProps> = React.memo(
  ({ shape = 'square' }) => {
    const borderRadius = shape === 'circle' ? 999 : 8;

    return (
      <View style={styles.container}>
        <Skeleton.Box
          width="100%"
          borderRadius={borderRadius}
          style={styles.image}
        />
        <View style={styles.textContainer}>
          <Skeleton.Box width="90%" height={14} borderRadius={4} />
          <Skeleton.Box width="60%" height={12} borderRadius={4} />
        </View>
      </View>
    );
  },
);
MediaCardSkeleton.displayName = 'MediaCardSkeleton';

const styles = StyleSheet.create({
  // Mirrors MediaCard.styles.container padding/radius.
  container: webViewStyle({
    padding: 6,
    borderRadius: 8,
    ...Platform.select({
      web: {
        minWidth: 0,
      },
    }),
  }),
  // Mirrors MediaCard.styles.imageContainer (square, bottom margin).
  image: {
    aspectRatio: 1,
    marginBottom: 6,
  },
  // Mirrors MediaCard.styles.textContainer min height + line spacing.
  textContainer: {
    minHeight: 42,
    gap: 6,
  },
});
