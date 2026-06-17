import React from 'react';
import { StyleSheet } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { Repeat } from './Repeat';
import { ResponsiveGrid } from '@/components/ResponsiveGrid';

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
      <ResponsiveGrid minItemWidth={160} gap={12}>
        <Repeat
          count={count}
          render={() => (
            <Skeleton.Box width="100%" style={styles.card} />
          )}
        />
      </ResponsiveGrid>
    );
  },
);
GenreGridSkeleton.displayName = 'GenreGridSkeleton';

const styles = StyleSheet.create({
  // Mirrors GenreCard.styles.container (4:3 aspect ratio).
  card: {
    aspectRatio: 4 / 3,
  },
});
