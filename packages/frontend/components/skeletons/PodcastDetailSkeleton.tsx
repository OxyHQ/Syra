import React from 'react';
import { StyleSheet, View, ScrollView } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '@oxyhq/bloom/theme';
import { LibraryListSkeleton } from './LibraryItemSkeleton';

interface PodcastDetailSkeletonProps {
  /** Number of placeholder episode rows. Defaults to 6. */
  episodeCount?: number;
}

/**
 * Full-page loading placeholder for the podcast show detail screen
 * (`app/podcasts/[id]`). Mirrors its real layout: a gradient hero (cover +
 * title + author + Subscribe pill) over the episode list — composed from the
 * shared skeleton primitives rather than reusing `MediaHeaderSkeleton`, whose
 * hero (host avatar + play/control row) does not match the podcast header.
 */
export const PodcastDetailSkeleton: React.FC<PodcastDetailSkeletonProps> =
  React.memo(({ episodeCount = 6 }) => {
    const theme = useTheme();
    const gradientColors: readonly [string, string, string] = [
      theme.colors.backgroundSecondary,
      theme.colors.backgroundSecondary,
      theme.colors.backgroundSecondary,
    ];

    return (
      <ScrollView
        style={[styles.container, { backgroundColor: theme.colors.backgroundSecondary }]}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero — mirrors the real cover-derived gradient header. */}
        <LinearGradient colors={gradientColors} locations={[0, 0.45, 1]} style={styles.hero}>
          <View style={styles.header}>
            <Skeleton.Box width={140} height={140} borderRadius={12} />
            <View style={styles.headerInfo}>
              <Skeleton.Box width="80%" height={24} borderRadius={6} />
              <Skeleton.Box width="50%" height={14} borderRadius={4} />
              <Skeleton.Box width={120} height={36} borderRadius={20} style={styles.subscribe} />
            </View>
          </View>
        </LinearGradient>

        {/* Episodes section title + rows. */}
        <Skeleton.Box width={110} height={20} borderRadius={5} style={styles.sectionTitle} />
        <LibraryListSkeleton count={episodeCount} />
      </ScrollView>
    );
  });
PodcastDetailSkeleton.displayName = 'PodcastDetailSkeleton';

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 120,
  },
  // Mirrors the real show screen's `hero`: bleeds past the content padding.
  hero: {
    marginHorizontal: -16,
    marginTop: -16,
    paddingHorizontal: 16,
    paddingTop: 16,
    marginBottom: 16,
  },
  header: {
    flexDirection: 'row',
    gap: 16,
  },
  headerInfo: {
    flex: 1,
    justifyContent: 'center',
    gap: 8,
  },
  subscribe: {
    marginTop: 4,
  },
  sectionTitle: {
    marginBottom: 8,
  },
});
