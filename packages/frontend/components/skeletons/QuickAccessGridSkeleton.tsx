import React from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { webDimension } from '@/utils/webStyles';
import { Repeat } from './Repeat';

interface QuickAccessGridSkeletonProps {
  /** Number of placeholder tiles. Defaults to 8 (the real grid's cap). */
  count?: number;
}

/**
 * Loading placeholder for the home "quick access" compact 2-column grid:
 * each tile is a 40x40 thumbnail beside a single title line.
 */
export const QuickAccessGridSkeleton: React.FC<QuickAccessGridSkeletonProps> =
  React.memo(({ count = 8 }) => {
    return (
      <View style={styles.compactGrid}>
        <Repeat
          count={count}
          render={() => (
            <View style={styles.compactGridItem}>
              <Skeleton.Box
                width={40}
                height={40}
                borderRadius={12}
                style={styles.compactImage}
              />
              <View style={styles.compactTitle}>
                <Skeleton.Box width="70%" height={13} borderRadius={4} />
              </View>
            </View>
          )}
        />
      </View>
    );
  });
QuickAccessGridSkeleton.displayName = 'QuickAccessGridSkeleton';

const styles = StyleSheet.create({
  // Mirrors home.styles.compactGrid.
  compactGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 24,
    gap: 8,
  },
  // Mirrors home.styles.compactGridItem.
  compactGridItem: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: 12,
    marginBottom: 4,
    alignItems: 'center',
    ...Platform.select({
      web: {
        width: webDimension('calc(50% - 4px)'),
      },
      default: {
        width: '48%',
      },
    }),
  },
  // Mirrors home.styles.compactImageContainer.
  compactImage: {
    marginRight: 6,
  },
  // Mirrors home.styles.compactTitle.
  compactTitle: {
    flex: 1,
  },
});
