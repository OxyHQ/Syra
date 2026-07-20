import React, { useMemo } from 'react';
import { StyleSheet, View, Text, Pressable, ScrollView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import SEO from '@/components/SEO';
import { TrackRow } from '@/components/TrackRow';
import { LibraryListSkeleton } from '@/components/skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { useAuthGate } from '@/hooks/useAuthGate';
import { libraryService } from '@/services/libraryService';
import { LIBRARY_TRACKS_QUERY_KEY } from '@/hooks/useLibrary';
import { usePlayerStore } from '@/stores/playerStore';
import { formatTotalDuration } from '@/utils/musicUtils';

/**
 * Liked Songs Screen (`/library/liked`)
 *
 * Lists the authenticated user's liked tracks from `GET /library/tracks`. The
 * heart on each {@link TrackRow} and the player bars share the same React Query
 * library cache, so un-liking here (or anywhere) keeps this list in sync via
 * the `['library', 'tracks']` invalidation wired into the like mutation.
 */
const LikedSongsScreen: React.FC = () => {
  const theme = useTheme();
  const router = useRouter();
  const { t } = useTranslation();
  const gate = useAuthGate();
  const { playTrackList, currentTrack, isPlaying } = usePlayerStore();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: LIBRARY_TRACKS_QUERY_KEY,
    queryFn: () => libraryService.getLikedTracks(),
    enabled: gate.canUsePrivateApi,
  });

  const tracks = data?.tracks ?? [];
  const total = data?.total ?? tracks.length;

  const totalDurationFormatted = useMemo(() => {
    const seconds = tracks.reduce((sum, track) => sum + (track.duration || 0), 0);
    return seconds > 0 ? formatTotalDuration(seconds) : '';
  }, [tracks]);

  const handlePlayAll = () => {
    if (tracks.length > 0) {
      playTrackList(tracks, 0, {
        type: 'library',
        id: 'liked',
        name: 'Liked Songs',
      });
    }
  };

  const handleTrackPress = (index: number) => {
    playTrackList(tracks, index, {
      type: 'library',
      id: 'liked',
      name: 'Liked Songs',
    });
  };

  // Terminal auth failure — bounded by the gate, so this can never sit on a
  // skeleton forever the way an unbounded `isPrivateApiPending` check did.
  if (gate.isTimedOut) {
    return (
      <EmptyState
        containerStyle={{ backgroundColor: theme.colors.backgroundSecondary }}
        icon={{ name: 'cloud-offline-outline' }}
        error={{
          title: 'Session unavailable',
          message: 'We could not confirm your session, so your liked songs stayed hidden. Please try again.',
          onRetry: async () => {
            gate.retry();
          },
        }}
      />
    );
  }

  if (gate.isResolving) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <LibraryListSkeleton count={8} />
      </View>
    );
  }

  if (!gate.canUsePrivateApi) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <Ionicons name="lock-closed-outline" size={48} color={theme.colors.textSecondary} style={styles.centeredIcon} />
        <Text style={[styles.centeredText, { color: theme.colors.textSecondary }]}>
          Sign in to view your liked songs
        </Text>
      </View>
    );
  }

  return (
    <>
      <SEO title="Liked Songs - Syra" description="Your liked songs" />
      <ScrollView
        style={[styles.scrollView, { backgroundColor: theme.colors.backgroundSecondary }]}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={[styles.coverArt, { backgroundColor: theme.colors.primary }]}>
            <Ionicons name="heart" size={64} color={theme.colors.primaryForeground} />
          </View>
          <View style={styles.headerInfo}>
            <Text style={[styles.headerEyebrow, { color: theme.colors.textSecondary }]}>Playlist</Text>
            <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Liked Songs</Text>
            <Text style={[styles.headerMeta, { color: theme.colors.textSecondary }]}>
              {isLoading ? '...' : `${total} ${total === 1 ? 'song' : 'songs'}`}
              {totalDurationFormatted ? ` • ${totalDurationFormatted}` : ''}
            </Text>
          </View>
        </View>

        {/* Controls */}
        <View style={styles.controlsContainer}>
          <Pressable
            style={[styles.playButton, { backgroundColor: theme.colors.primary }]}
            onPress={handlePlayAll}
            disabled={tracks.length === 0}
            accessibilityRole="button"
            accessibilityLabel={t('Play')}
          >
            <Ionicons name="play" size={28} color={theme.colors.primaryForeground} />
          </Pressable>
        </View>

        {/* Track list */}
        {isLoading ? (
          <View style={styles.trackList}>
            <LibraryListSkeleton count={8} />
          </View>
        ) : isError ? (
          <EmptyState
            containerStyle={styles.inlineState}
            icon={{ name: 'cloud-offline-outline' }}
            error={{
              title: 'Could not load your liked songs',
              message: 'Something went wrong while loading this list. Please try again.',
              onRetry: async () => {
                await refetch();
              },
            }}
          />
        ) : tracks.length === 0 ? (
          <View style={styles.centered}>
            <Ionicons name="heart-outline" size={48} color={theme.colors.textSecondary} style={styles.centeredIcon} />
            <Text style={[styles.centeredText, { color: theme.colors.textSecondary }]}>
              Songs you like will appear here
            </Text>
            <Pressable
              onPress={() => router.push('/search')}
              style={[styles.findButton, { backgroundColor: theme.colors.primary }]}
            >
              <Text style={[styles.findButtonText, { color: theme.colors.primaryForeground }]}>Find something to like</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.trackList}>
            {tracks.map((track, index) => {
              const isCurrentTrack = currentTrack?.id === track.id;
              const isTrackPlaying = isCurrentTrack && isPlaying;
              return (
                <TrackRow
                  key={track.id}
                  track={track}
                  index={index}
                  isCurrentTrack={isCurrentTrack}
                  isTrackPlaying={isTrackPlaying}
                  onPress={() => handleTrackPress(index)}
                  onPlayPress={() => handleTrackPress(index)}
                  showNumber={true}
                />
              );
            })}
          </View>
        )}
      </ScrollView>
    </>
  );
};

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 100,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 20,
    padding: 24,
    paddingBottom: 16,
  },
  coverArt: {
    width: 160,
    height: 160,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        maxWidth: 160,
        maxHeight: 160,
      },
    }),
  },
  headerInfo: {
    flex: 1,
    minWidth: 0,
  },
  headerEyebrow: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  headerTitle: {
    fontSize: 42,
    fontWeight: 'bold',
    letterSpacing: -0.5,
    marginBottom: 8,
  },
  headerMeta: {
    fontSize: 14,
  },
  controlsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 16,
    gap: 12,
  },
  playButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  trackList: {
    paddingHorizontal: 24,
  },
  centered: {
    padding: 48,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  // States rendered INSIDE the scroll view: no `flex: 1` stretch and no opaque
  // background of their own, so they sit inline under the header + controls.
  inlineState: {
    flex: 0,
    paddingVertical: 32,
    backgroundColor: 'transparent',
  },
  centeredIcon: {
    opacity: 0.5,
  },
  centeredText: {
    fontSize: 14,
    textAlign: 'center',
  },
  findButton: {
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  findButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
});

export default LikedSongsScreen;
