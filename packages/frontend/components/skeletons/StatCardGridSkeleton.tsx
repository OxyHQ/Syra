import React from 'react';
import { StyleSheet, View } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { Repeat } from './Repeat';

interface StatCardGridSkeletonProps {
  /** Number of stat cards. Defaults to 4. */
  count?: number;
  /** Minimum card width as a percentage of the row — mirrors the real grid. */
  minWidth?: '30%' | '45%';
  /** When true, renders a period-selector pill row above the cards. */
  showPeriodSelector?: boolean;
}

/**
 * Loading placeholder for the artist insights / dashboard screens: an optional
 * period-selector row followed by a wrapping grid of stat cards (icon + value
 * + label). Mirrors `artist/insights` and `artist/dashboard` layout.
 */
export const StatCardGridSkeleton: React.FC<StatCardGridSkeletonProps> =
  React.memo(({ count = 4, minWidth = '30%', showPeriodSelector = false }) => {
    return (
      <View style={styles.content}>
        {showPeriodSelector && (
          <View style={styles.periodSelector}>
            <Repeat
              count={3}
              render={() => (
                <Skeleton.Box height={40} borderRadius={20} style={styles.periodButton} />
              )}
            />
          </View>
        )}

        <View style={styles.statsGrid}>
          <Repeat
            count={count}
            render={() => (
              <View style={[styles.statCard, { minWidth }]}>
                <Skeleton.Circle size={32} />
                <Skeleton.Box width={64} height={24} borderRadius={6} />
                <Skeleton.Box width={80} height={12} borderRadius={4} />
              </View>
            )}
          />
        </View>
      </View>
    );
  });
StatCardGridSkeleton.displayName = 'StatCardGridSkeleton';

const styles = StyleSheet.create({
  // Mirrors insights/dashboard `scrollContent` spacing.
  content: {
    padding: 16,
    gap: 24,
  },
  // Mirrors insights `periodSelector`.
  periodSelector: {
    flexDirection: 'row',
    gap: 8,
  },
  // Mirrors insights `periodButton`.
  periodButton: {
    flex: 1,
  },
  // Mirrors insights/dashboard `statsGrid`.
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  // Mirrors insights/dashboard `statCard`.
  statCard: {
    flex: 1,
    padding: 16,
    borderRadius: 16,
    alignItems: 'center',
    gap: 8,
  },
});
