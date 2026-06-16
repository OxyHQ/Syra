import React from 'react';
import { StyleSheet, View } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';

interface TrackRowSkeletonProps {
  /** Mirrors {@link TrackRow}'s `showNumber` — reserves the index column. */
  showNumber?: boolean;
}

/**
 * Loading placeholder mirroring a single {@link TrackRow}: optional index
 * column, a stacked title/artist block, and a trailing duration.
 */
export const TrackRowSkeleton: React.FC<TrackRowSkeletonProps> = React.memo(
  ({ showNumber = true }) => {
    return (
      <View style={styles.trackRow}>
        <View style={styles.trackRowLeft}>
          {showNumber && (
            <View style={styles.trackNumberContainer}>
              <Skeleton.Box width={14} height={14} borderRadius={4} />
            </View>
          )}
          <View style={styles.trackInfo}>
            <Skeleton.Box width="55%" height={15} borderRadius={4} />
            <Skeleton.Box width="35%" height={14} borderRadius={4} />
          </View>
        </View>
        <Skeleton.Box width={40} height={14} borderRadius={4} />
      </View>
    );
  },
);
TrackRowSkeleton.displayName = 'TrackRowSkeleton';

interface TrackListSkeletonProps {
  /** Number of placeholder rows. Defaults to 6. */
  count?: number;
  showNumber?: boolean;
}

/**
 * Vertical list of {@link TrackRowSkeleton}s for track sections (home tracks,
 * album/playlist track lists, search track results).
 */
export const TrackListSkeleton: React.FC<TrackListSkeletonProps> = React.memo(
  ({ count = 6, showNumber = true }) => {
    return (
      <View>
        {Array.from({ length: count }).map((_, index) => (
          <TrackRowSkeleton key={index} showNumber={showNumber} />
        ))}
      </View>
    );
  },
);
TrackListSkeleton.displayName = 'TrackListSkeleton';

const styles = StyleSheet.create({
  // Mirrors TrackRow.styles.trackRow spacing.
  trackRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 8,
    minHeight: 48,
  },
  // Mirrors TrackRow.styles.trackRowLeft.
  trackRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    flex: 1,
    minWidth: 0,
  },
  // Mirrors TrackRow.styles.trackNumberContainer.
  trackNumberContainer: {
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Mirrors TrackRow.styles.trackInfo with line spacing.
  trackInfo: {
    flex: 1,
    minWidth: 0,
    gap: 6,
  },
});
