import React from 'react';
import { StyleSheet, View } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { TrackListSkeleton } from './TrackRowSkeleton';
import { MediaCardRowSkeleton } from './MediaCardRowSkeleton';

const HERO_HEIGHT = 400;

interface ArtistDetailSkeletonProps {
  /** Number of placeholder track rows in the "Popular" section. Defaults to 6. */
  trackCount?: number;
  /** Number of placeholder album cards. Defaults to 5. */
  albumCount?: number;
}

/**
 * Full-page loading placeholder for the artist detail screen: a large parallax
 * hero, a "Popular" track list, and an "Albums" grid. Mirrors `artist/[id]`
 * layout.
 */
export const ArtistDetailSkeleton: React.FC<ArtistDetailSkeletonProps> =
  React.memo(({ trackCount = 6, albumCount = 5 }) => {
    return (
      <View>
        {/* Hero header */}
        <Skeleton.Box width="100%" height={HERO_HEIGHT} borderRadius={0} />

        {/* Popular tracks */}
        <View style={styles.sectionHeader}>
          <Skeleton.Box width={120} height={22} borderRadius={6} />
        </View>
        <View style={styles.trackList}>
          <TrackListSkeleton count={trackCount} />
        </View>

        {/* Albums grid */}
        <View style={styles.sectionHeader}>
          <Skeleton.Box width={100} height={22} borderRadius={6} />
        </View>
        <View style={styles.albumsGrid}>
          <MediaCardRowSkeleton count={albumCount} />
        </View>
      </View>
    );
  });
ArtistDetailSkeleton.displayName = 'ArtistDetailSkeleton';

const styles = StyleSheet.create({
  // Mirrors artist/[id] `sectionHeader`.
  sectionHeader: {
    paddingHorizontal: 24,
    paddingBottom: 16,
    paddingTop: 8,
  },
  // Mirrors artist/[id] `trackList`.
  trackList: {
    paddingHorizontal: 24,
    gap: 4,
  },
  // Mirrors artist/[id] `albumsGrid` horizontal inset.
  albumsGrid: {
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
});
