import React from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import { MediaCardSkeleton } from './MediaCardSkeleton';

interface MediaCardRowSkeletonProps {
  /** Number of placeholder cards to render. Defaults to 5 (one desktop row). */
  count?: number;
  /** Card shape — mirrors the real section's card type. */
  shape?: 'square' | 'circle';
}

/**
 * Loading placeholder for a horizontally-wrapping grid of {@link MediaCard}s
 * (home "Recently played" / "Made for you" / "Tracks", search result grids).
 * Matches the screens' `grid` / `gridItem` 5-up desktop / 2-up mobile layout.
 */
export const MediaCardRowSkeleton: React.FC<MediaCardRowSkeletonProps> =
  React.memo(({ count = 5, shape = 'square' }) => {
    return (
      <View style={styles.grid}>
        {Array.from({ length: count }).map((_, index) => (
          <View key={index} style={styles.gridItem}>
            <MediaCardSkeleton shape={shape} />
          </View>
        ))}
      </View>
    );
  });
MediaCardRowSkeleton.displayName = 'MediaCardRowSkeleton';

const styles = StyleSheet.create({
  // Mirrors the screens' `grid` style.
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
  },
  // Mirrors the screens' `gridItem` style (5 columns desktop, 2 mobile).
  gridItem: {
    paddingHorizontal: 4,
    paddingBottom: 6,
    ...Platform.select({
      web: {
        width: '20%',
        minWidth: 180,
        maxWidth: 220,
      },
      default: {
        width: '50%',
      },
    }),
  },
});
