import React from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '@oxyhq/bloom/theme';
import { TrackListSkeleton } from './TrackRowSkeleton';

interface MediaHeaderSkeletonProps {
  /** Number of placeholder track rows below the header. Defaults to 8. */
  trackCount?: number;
}

/**
 * Full-page loading placeholder for the album and playlist detail screens:
 * a large cover, title, artist row and metadata, a control bar, and a track
 * list. Mirrors `album/[id]` and `playlist/[id]` header layout.
 */
export const MediaHeaderSkeleton: React.FC<MediaHeaderSkeletonProps> =
  React.memo(({ trackCount = 8 }) => {
    const theme = useTheme();
    const gradientColors: readonly [string, string, string] = [
      theme.colors.backgroundSecondary,
      theme.colors.background,
      theme.colors.background,
    ];

    return (
      <View>
        <LinearGradient colors={gradientColors} locations={[0, 0.45, 1]} style={styles.heroSection}>
          {/* Header: cover + info */}
          <View style={styles.header}>
            <View style={styles.coverContainer}>
              <Skeleton.Box width="100%" height="100%" borderRadius={8} />
            </View>
            <View style={styles.infoContainer}>
              <Skeleton.Box
                width="80%"
                height={42}
                borderRadius={6}
                style={styles.title}
              />
              <View style={styles.artistRow}>
                <Skeleton.Circle size={24} />
                <Skeleton.Box width={120} height={16} borderRadius={4} />
              </View>
              <Skeleton.Box width="45%" height={14} borderRadius={4} />
            </View>
          </View>

          {/* Control bar: play button + secondary actions */}
          <View style={styles.controlsContainer}>
            <Skeleton.Circle size={56} />
            <Skeleton.Circle size={24} />
            <Skeleton.Circle size={24} />
            <Skeleton.Circle size={24} />
          </View>
        </LinearGradient>

        <View style={[styles.divider, { borderBottomColor: theme.colors.backgroundSecondary }]} />
        <View style={styles.trackListHeader}>
          <View style={styles.trackListHeaderLeft}>
            <Skeleton.Box width={10} height={12} borderRadius={3} />
            <Skeleton.Box width={40} height={12} borderRadius={3} />
          </View>
          <Skeleton.Circle size={16} />
        </View>

        {/* Track list */}
        <View style={styles.trackList}>
          <TrackListSkeleton count={trackCount} />
        </View>
      </View>
    );
  });
MediaHeaderSkeleton.displayName = 'MediaHeaderSkeleton';

const styles = StyleSheet.create({
  heroSection: {
    paddingTop: 0,
  },
  // Mirrors album/playlist `header`.
  header: {
    flexDirection: 'row',
    padding: 24,
    paddingBottom: 16,
    gap: 20,
    ...Platform.select({
      native: {
        flexWrap: 'wrap',
      },
    }),
  },
  // Mirrors album/playlist `coverContainer`.
  coverContainer: {
    width: 160,
    height: 160,
    maxWidth: 160,
    maxHeight: 160,
  },
  // Mirrors album/playlist `infoContainer`.
  infoContainer: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingBottom: 8,
    gap: 8,
  },
  title: {
    marginBottom: 0,
  },
  // Mirrors album/playlist `artistRow`.
  artistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  // Mirrors album/playlist `controlsContainer`.
  controlsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 12,
    gap: 12,
  },
  divider: {
    borderBottomWidth: 1,
    marginHorizontal: 24,
    marginBottom: 8,
  },
  trackListHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 8,
  },
  trackListHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    flex: 1,
  },
  // Mirrors album/playlist `trackList`.
  trackList: {
    paddingHorizontal: 24,
  },
});
