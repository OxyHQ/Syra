import React from 'react';
import { StyleSheet, View } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '@oxyhq/bloom/theme';
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
    const theme = useTheme();
    const contentGradient: readonly [string, string, string] = [
      theme.colors.backgroundSecondary,
      theme.colors.background,
      theme.colors.background,
    ];

    return (
      <View>
        {/* Hero header */}
        <View style={styles.hero}>
          <Skeleton.Box width="100%" height={HERO_HEIGHT} borderRadius={0} />
          <LinearGradient
            colors={['transparent', 'rgba(0, 0, 0, 0.3)', 'rgba(0, 0, 0, 0.7)']}
            locations={[0, 0.6, 1]}
            style={styles.heroOverlay}
          />
          <View style={styles.titleContainer}>
            <Skeleton.Box width="55%" height={72} borderRadius={8} />
          </View>
        </View>

        <LinearGradient colors={contentGradient} locations={[0, 0.35, 1]} style={styles.contentSection}>
          <View style={styles.infoContainer}>
            <View style={styles.infoHeader}>
              <Skeleton.Circle size={64} />
              <View style={styles.infoTextContainer}>
                <Skeleton.Box width="72%" height={14} borderRadius={4} />
                <Skeleton.Box width="54%" height={14} borderRadius={4} />
              </View>
            </View>
          </View>

          <View style={styles.controlsContainer}>
            <Skeleton.Circle size={56} />
            <Skeleton.Circle size={24} />
            <Skeleton.Circle size={24} />
          </View>

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
        </LinearGradient>
      </View>
    );
  });
ArtistDetailSkeleton.displayName = 'ArtistDetailSkeleton';

const styles = StyleSheet.create({
  hero: {
    height: HERO_HEIGHT,
    width: '100%',
    overflow: 'hidden',
    position: 'relative',
  },
  heroOverlay: {
    ...StyleSheet.absoluteFill,
  },
  titleContainer: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 16,
  },
  contentSection: {
    paddingTop: 0,
    minHeight: '100%',
  },
  infoContainer: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 24,
  },
  infoHeader: {
    flexDirection: 'row',
    gap: 16,
    alignItems: 'flex-start',
  },
  infoTextContainer: {
    flex: 1,
    minWidth: 0,
    gap: 8,
    paddingTop: 4,
  },
  controlsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 24,
    gap: 16,
  },
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
