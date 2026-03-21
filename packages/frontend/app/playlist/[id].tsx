import React, { useState, useEffect, useMemo } from 'react';
import { StyleSheet, View, Text, Pressable, Image, ActivityIndicator, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Animated, {
  interpolate,
  useAnimatedRef,
  useAnimatedStyle,
  useScrollViewOffset,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '@/hooks/useTheme';
import { musicService } from '@/services/musicService';
import { Playlist, Track } from '@syra/shared-types';
import { Ionicons } from '@expo/vector-icons';
import { usePlayerStore } from '@/stores/playerStore';
import SEO from '@/components/SEO';
import { TrackRow } from '@/components/TrackRow';
import { formatDuration, formatTotalDuration } from '@/utils/musicUtils';

const HEADER_HEIGHT = 400;

/**
 * Playlist Screen
 * Displays playlist details with parallax header, gradient overlay, and track list
 */
const PlaylistScreen: React.FC = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const { playTrack, currentTrack, isPlaying } = usePlayerStore();

  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [isLiked, setIsLiked] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState(false);

  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollOffset = useScrollViewOffset(scrollRef);

  useEffect(() => {
    if (id) {
      fetchPlaylistData();
    }
  }, [id]);

  const fetchPlaylistData = async () => {
    try {
      setLoading(true);
      const [playlistData, tracksData] = await Promise.all([
        musicService.getPlaylistById(id!),
        musicService.getPlaylistTracks(id!)
      ]);
      setPlaylist(playlistData);
      setTracks(tracksData.tracks);
    } catch (error) {
      console.error('[PlaylistScreen] Error fetching playlist:', error);
    } finally {
      setLoading(false);
    }
  };

  // Parallax animation for header image
  const headerAnimatedStyle = useAnimatedStyle(() => {
    return {
      transform: [
        {
          translateY: interpolate(
            scrollOffset.value,
            [-HEADER_HEIGHT, 0, HEADER_HEIGHT],
            [-HEADER_HEIGHT / 2, 0, HEADER_HEIGHT * 0.75]
          ),
        },
        {
          scale: interpolate(scrollOffset.value, [-HEADER_HEIGHT, 0, HEADER_HEIGHT], [2, 1, 1]),
        },
      ],
    };
  });

  // Animated style for title in header - fades out as you scroll
  const headerTitleAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      scrollOffset.value,
      [0, HEADER_HEIGHT - 100, HEADER_HEIGHT - 50],
      [1, 0.3, 0],
      'clamp'
    );
    return {
      opacity,
    };
  });

  // Animated style for sticky header - fades in as you scroll
  const stickyHeaderAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      scrollOffset.value,
      [HEADER_HEIGHT - 100, HEADER_HEIGHT - 50],
      [0, 1],
      'clamp'
    );
    const translateY = interpolate(
      scrollOffset.value,
      [HEADER_HEIGHT - 100, HEADER_HEIGHT - 50],
      [-20, 0],
      'clamp'
    );
    return {
      opacity,
      transform: [{ translateY }],
    };
  });

  // Helper function to convert hex color to RGB
  const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
      : null;
  };

  // Convert hex to rgba string for LinearGradient
  const hexToRgba = (hex: string, alpha: number = 0.2): string => {
    const rgb = hexToRgb(hex);
    if (!rgb) return `rgba(128, 128, 128, ${alpha})`; // Fallback gray
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  };

  // Get gradient colors from playlist primaryColor or fallback to theme primary
  // 2-stop gradient: primaryColor -> theme background
  const getGradientColors = (): [string, string] => {
    const topColor = playlist?.primaryColor
      ? playlist.primaryColor
      : theme.colors.primary;
    return [topColor, theme.colors.background];
  };

  const handlePlayPlaylist = () => {
    if (tracks.length > 0) {
      playTrack(tracks[0]);
    }
  };

  const handleTrackPress = (track: Track) => {
    playTrack(track);
  };

  const totalDurationFormatted = useMemo(() => {
    if (playlist?.totalDuration) {
      return formatTotalDuration(playlist.totalDuration);
    }
    return '';
  }, [playlist?.totalDuration]);

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  if (!playlist) {
    return (
      <View style={[styles.errorContainer, { backgroundColor: theme.colors.background }]}>
        <Text style={[styles.errorText, { color: theme.colors.text }]}>Playlist not found</Text>
      </View>
    );
  }

  return (
    <>
      <SEO
        title={`${playlist.name} - Syra`}
        description={playlist.description || `Listen to ${playlist.name}`}
      />
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        {/* Sticky Header */}
        <Animated.View
          style={[
            styles.stickyHeader,
            {
              backgroundColor: theme.colors.background,
              borderBottomColor: theme.colors.backgroundSecondary,
            },
            stickyHeaderAnimatedStyle
          ]}
          pointerEvents="box-none"
        >
          <View style={styles.stickyHeaderContent}>
            {/* Center - Title and cover art */}
            <View style={styles.stickyHeaderCenter}>
              <View style={[styles.stickyHeaderImageContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
                {playlist.coverArt ? (
                  <Image
                    source={{ uri: playlist.coverArt }}
                    style={styles.stickyHeaderImage}
                    resizeMode="cover"
                  />
                ) : (
                  <Ionicons name="musical-notes" size={20} color={theme.colors.textSecondary} />
                )}
              </View>
              <Text style={[styles.stickyHeaderTitle, { color: theme.colors.text }]} numberOfLines={1}>
                {playlist.name}
              </Text>
            </View>

            {/* Right side - Controls */}
            <View style={styles.stickyHeaderControls}>
              <Pressable
                style={[styles.stickyHeaderPlayButton, { backgroundColor: theme.colors.primary }]}
                onPress={handlePlayPlaylist}
              >
                <Ionicons name="play" size={16} color="#000" />
              </Pressable>
              <Pressable
                style={styles.stickyHeaderControlButton}
                onPress={() => setIsLiked(!isLiked)}
              >
                <Ionicons
                  name={isLiked ? "heart" : "heart-outline"}
                  size={20}
                  color={isLiked ? theme.colors.primary : theme.colors.text}
                />
              </Pressable>
              <Pressable style={styles.stickyHeaderControlButton}>
                <Ionicons name="ellipsis-horizontal" size={20} color={theme.colors.text} />
              </Pressable>
            </View>
          </View>
        </Animated.View>

        <Animated.ScrollView
          ref={scrollRef}
          scrollEventThrottle={16}
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          contentInsetAdjustmentBehavior="never"
        >
          {/* Parallax Header Section */}
          <Animated.View style={[styles.headerContainer, headerAnimatedStyle]}>
            {playlist.coverArt ? (
              <Image
                source={{ uri: playlist.coverArt }}
                style={styles.headerImage}
                resizeMode="cover"
              />
            ) : (
              <View style={[styles.headerPlaceholder, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <Ionicons name="musical-notes" size={80} color={theme.colors.textSecondary} />
              </View>
            )}
            {/* Gradient overlay for text readability */}
            <LinearGradient
              colors={['transparent', 'rgba(0, 0, 0, 0.3)', 'rgba(0, 0, 0, 0.7)'] as readonly [string, string, string]}
              locations={[0, 0.6, 1] as readonly [number, number, number]}
              style={styles.headerOverlay}
            />
            {/* Playlist Title */}
            <Animated.View style={[styles.titleContainer, headerTitleAnimatedStyle]}>
              <Text style={[styles.playlistTitle, { color: '#FFFFFF' }]} numberOfLines={2}>
                {playlist.name}
              </Text>
            </Animated.View>
          </Animated.View>

          {/* Content Section with Gradient Background */}
          <LinearGradient
            colors={getGradientColors()}
            locations={[0, 0.2]}
            style={styles.contentSection}
          >
            {/* Playlist Info */}
            <View style={styles.infoContainer}>
              <View style={styles.infoHeader}>
                {playlist.coverArt && (
                  <Image
                    source={{ uri: playlist.coverArt }}
                    style={styles.infoCoverImage}
                    resizeMode="cover"
                  />
                )}
                <View style={styles.infoTextContainer}>
                  {playlist.description && (
                    <Text style={[styles.description, { color: theme.colors.textSecondary }]} numberOfLines={2}>
                      {playlist.description}
                    </Text>
                  )}
                  <View style={styles.metadataRow}>
                    <Text style={[styles.metadata, { color: theme.colors.textSecondary }]}>
                      {playlist.ownerUsername}
                    </Text>
                    {playlist.trackCount > 0 && (
                      <>
                        <Text style={[styles.metadataSeparator, { color: theme.colors.textSecondary }]}>•</Text>
                        <Text style={[styles.metadata, { color: theme.colors.textSecondary }]}>
                          {playlist.trackCount} {playlist.trackCount === 1 ? 'song' : 'songs'}
                        </Text>
                        {totalDurationFormatted && (
                          <>
                            <Text style={[styles.metadataSeparator, { color: theme.colors.textSecondary }]}>•</Text>
                            <Text style={[styles.metadata, { color: theme.colors.textSecondary }]}>
                              {totalDurationFormatted}
                            </Text>
                          </>
                        )}
                      </>
                    )}
                    {playlist.followers !== undefined && playlist.followers > 0 && (
                      <>
                        <Text style={[styles.metadataSeparator, { color: theme.colors.textSecondary }]}>•</Text>
                        <Text style={[styles.metadata, { color: theme.colors.textSecondary }]}>
                          {playlist.followers.toLocaleString()} {playlist.followers === 1 ? 'save' : 'saves'}
                        </Text>
                      </>
                    )}
                  </View>
                </View>
              </View>
            </View>

            {/* Playback Controls */}
            <View style={styles.controlsContainer}>
              <Pressable
                style={[styles.playButton, { backgroundColor: theme.colors.primary }]}
                onPress={handlePlayPlaylist}
              >
                <View style={styles.playButtonInner}>
                  <Ionicons name="play" size={24} color="#000" />
                </View>
              </Pressable>

              <Pressable
                style={styles.controlButton}
                onPress={() => {
                  // Shuffle functionality
                }}
              >
                <Ionicons name="shuffle" size={22} color={theme.colors.text} />
              </Pressable>

              <Pressable
                style={styles.controlButton}
                onPress={() => setIsLiked(!isLiked)}
              >
                <Ionicons
                  name={isLiked ? "heart" : "heart-outline"}
                  size={24}
                  color={isLiked ? '#1DB954' : theme.colors.text}
                />
              </Pressable>

              <Pressable
                style={styles.controlButton}
                onPress={() => setIsDownloaded(!isDownloaded)}
              >
                <Ionicons
                  name={isDownloaded ? "arrow-down-circle" : "arrow-down-circle-outline"}
                  size={24}
                  color={theme.colors.text}
                />
              </Pressable>

              <Pressable style={styles.controlButton}>
                <Ionicons name="ellipsis-horizontal" size={24} color={theme.colors.text} />
              </Pressable>
            </View>

            {/* Divider */}
            <View style={[styles.divider, { borderBottomColor: theme.colors.backgroundSecondary }]} />

            {/* Track List Header */}
            <View style={styles.trackListHeader}>
              <View style={styles.trackListHeaderLeft}>
                <Text style={[styles.trackListHeaderText, { color: theme.colors.textSecondary }]}>#</Text>
                <Text style={[styles.trackListHeaderText, { color: theme.colors.textSecondary }]}>Title</Text>
              </View>
              <Ionicons name="time-outline" size={16} color={theme.colors.textSecondary} />
            </View>

            {/* Track List */}
            <View style={styles.trackList}>
              {tracks.length === 0 ? (
                <View style={styles.emptyState}>
                  <Text style={[styles.emptyStateText, { color: theme.colors.textSecondary }]}>
                    No tracks in this playlist
                  </Text>
                </View>
              ) : (
                tracks.map((track, index) => {
                  const isCurrentTrack = currentTrack?.id === track.id;
                  const isTrackPlaying = isCurrentTrack && isPlaying;

                  return (
                    <TrackRow
                      key={track.id}
                      track={track}
                      index={index}
                      isCurrentTrack={isCurrentTrack}
                      isTrackPlaying={isTrackPlaying}
                      onPress={() => handleTrackPress(track)}
                      onPlayPress={() => handleTrackPress(track)}
                      showNumber={true}
                    />
                  );
                })
              )}
            </View>
          </LinearGradient>
        </Animated.ScrollView>
      </View>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    marginTop: 0,
    paddingTop: 0,
  },
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 64,
    zIndex: 1000,
    justifyContent: 'center',
    borderBottomWidth: 1,
    ...Platform.select({
      web: {
        position: 'sticky' as any,
      },
    }),
  },
  stickyHeaderContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    height: '100%',
  },
  stickyHeaderButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  stickyHeaderCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minWidth: 0,
    marginHorizontal: 0,
  },
  stickyHeaderImageContainer: {
    width: 40,
    height: 40,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  stickyHeaderImage: {
    width: '100%',
    height: '100%',
  },
  stickyHeaderTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    letterSpacing: -0.3,
    flex: 1,
    textAlign: 'left',
  },
  stickyHeaderControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stickyHeaderPlayButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
        transition: 'transform 0.2s',
        ':hover': {
          transform: 'scale(1.1)',
        },
      },
    }),
  },
  stickyHeaderControlButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 100,
    paddingTop: 0,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorText: {
    fontSize: 16,
  },
  headerContainer: {
    height: HEADER_HEIGHT,
    width: '100%',
    overflow: 'hidden',
    position: 'relative',
    marginTop: 0,
    marginBottom: 0,
  },
  headerImage: {
    width: '100%',
    height: '100%',
  },
  headerPlaceholder: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  titleContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 24,
    paddingBottom: 16,
  },
  playlistTitle: {
    fontSize: 96,
    fontWeight: '900',
    letterSpacing: -2,
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
    lineHeight: 96,
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
  infoCoverImage: {
    width: 64,
    height: 64,
    borderRadius: 4,
  },
  infoTextContainer: {
    flex: 1,
    minWidth: 0,
  },
  description: {
    fontSize: 14,
    marginBottom: 12,
    lineHeight: 20,
  },
  metadataRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  metadata: {
    fontSize: 14,
  },
  metadataSeparator: {
    fontSize: 14,
    marginHorizontal: 8,
  },
  controlsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 24,
    gap: 16,
  },
  playButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
    overflow: 'hidden',
    ...Platform.select({
      web: {
        cursor: 'pointer',
        transition: 'transform 0.2s',
        ':hover': {
          transform: 'scale(1.05)',
        },
      },
    }),
  },
  playButtonInner: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 28,
  },
  controlButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 20,
    ...Platform.select({
      web: {
        cursor: 'pointer',
        transition: 'transform 0.2s, background-color 0.2s',
      },
    }),
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
    borderBottomWidth: 0,
  },
  trackListHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    flex: 1,
  },
  trackListHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  trackList: {
    paddingHorizontal: 24,
  },
  emptyState: {
    paddingVertical: 48,
    alignItems: 'center',
  },
  emptyStateText: {
    fontSize: 14,
  },
});

export default PlaylistScreen;

