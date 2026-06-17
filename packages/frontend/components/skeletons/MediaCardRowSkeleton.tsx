import React from 'react';
import { MediaCardSkeleton } from './MediaCardSkeleton';
import { Repeat } from './Repeat';
import { ResponsiveGrid } from '@/components/ResponsiveGrid';

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
      <ResponsiveGrid minItemWidth={180} maxItemWidth={220} gap={8}>
        <Repeat
          count={count}
          render={() => (
            <>
              <MediaCardSkeleton shape={shape} />
            </>
          )}
        />
      </ResponsiveGrid>
    );
  });
MediaCardRowSkeleton.displayName = 'MediaCardRowSkeleton';
