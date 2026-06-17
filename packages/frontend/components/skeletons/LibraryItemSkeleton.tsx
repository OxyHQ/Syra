import React from 'react';
import { StyleSheet, View } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { useTheme } from '@oxyhq/bloom/theme';
import { Repeat } from './Repeat';

interface LibraryItemSkeletonProps {
  /** `circle` mirrors followed-artist rows; `square` mirrors playlist rows. */
  shape?: 'square' | 'circle';
}

/**
 * Loading placeholder mirroring a single library list row: a 48x48 thumbnail
 * followed by a title line and a shorter subtitle line.
 */
export const LibraryItemSkeleton: React.FC<LibraryItemSkeletonProps> =
  React.memo(({ shape = 'square' }) => {
    const theme = useTheme();

    return (
      <View style={[styles.libraryItem, { backgroundColor: theme.colors.backgroundTertiary }]}>
        {shape === 'circle' ? (
          <Skeleton.Circle size={48} />
        ) : (
          <Skeleton.Box width={48} height={48} borderRadius={4} />
        )}
        <View style={styles.itemContent}>
          <Skeleton.Box width="50%" height={14} borderRadius={4} />
          <Skeleton.Box width="35%" height={12} borderRadius={4} />
        </View>
      </View>
    );
  });
LibraryItemSkeleton.displayName = 'LibraryItemSkeleton';

interface LibraryListSkeletonProps {
  /** Number of placeholder rows. Defaults to 6. */
  count?: number;
  shape?: 'square' | 'circle';
}

/** Vertical list of {@link LibraryItemSkeleton}s for the library screen. */
export const LibraryListSkeleton: React.FC<LibraryListSkeletonProps> =
  React.memo(({ count = 6, shape = 'square' }) => {
    return (
      <View>
        <Repeat count={count} render={() => <LibraryItemSkeleton shape={shape} />} />
      </View>
    );
  });
LibraryListSkeleton.displayName = 'LibraryListSkeleton';

const styles = StyleSheet.create({
  // Mirrors library.styles.libraryItem.
  libraryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 8,
    borderRadius: 6,
    marginBottom: 8,
  },
  // Mirrors library.styles.itemContent with line spacing.
  itemContent: {
    flex: 1,
    gap: 6,
  },
});
