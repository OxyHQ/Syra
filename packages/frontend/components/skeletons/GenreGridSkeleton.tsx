import React from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';

interface GenreGridSkeletonProps {
  /** Number of placeholder cards. Defaults to 8. */
  count?: number;
}

/**
 * Loading placeholder for the search "Browse All" genre grid: a wrapping grid
 * of 4:3 cards. Mirrors {@link GenreCard} dimensions and the search screen's
 * `genreGrid` / `genreGridItem` 4-up desktop / 2-up mobile layout.
 */
export const GenreGridSkeleton: React.FC<GenreGridSkeletonProps> = React.memo(
  ({ count = 8 }) => {
    return (
      <View style={styles.genreGrid}>
        {Array.from({ length: count }).map((_, index) => (
          <View key={index} style={styles.genreGridItem}>
            <Skeleton.Box width="100%" style={styles.card} />
          </View>
        ))}
      </View>
    );
  },
);
GenreGridSkeleton.displayName = 'GenreGridSkeleton';

const styles = StyleSheet.create({
  // Mirrors search.styles.genreGrid.
  genreGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -6,
  },
  // Mirrors search.styles.genreGridItem.
  genreGridItem: {
    paddingHorizontal: 6,
    paddingBottom: 12,
    ...Platform.select({
      web: {
        width: '25%',
        minWidth: 160,
        maxWidth: 240,
      },
      default: {
        width: '50%',
      },
    }),
  },
  // Mirrors GenreCard.styles.container (4:3 aspect ratio).
  card: {
    aspectRatio: 4 / 3,
  },
});
