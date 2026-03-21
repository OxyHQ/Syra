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
import { Artist, Track, Album } from '@syra/shared-types';
import { Ionicons } from '@expo/vector-icons';
import { usePlayerStore } from '@/stores/playerStore';
import SEO from '@/components/SEO';
import { TrackRow } from '@/components/TrackRow';
import { MediaCard } from '@/components/MediaCard';
import { toast } from 'sonner';
import { useOxy } from '@oxyhq/services';

const HEADER_HEIGHT = 400;

/**
 * Artist Screen
 * Displays artist details with parallax header, gradient overlay, albums grid, and tracks list
 */
const ArtistScreen: React.FC = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const { playTrack, currentTrack, isPlaying } = usePlayerStore();
  const { isAuthenticated } = useOxy();

  const [artist, setArtist] = useState<Artist | null>(null);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [isFollowed, setIsFollowed] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);

  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollOffset = useScrollViewOffset(scrollRef);

  useEffect(() => {
    if (id) {
      fetchArtistData();
    }
  }, [id]);

  const fetchArtistData = async () => {
    try {
      setLoading(true);
      const [artistData, albumsData, tracksData] = await Promise.all([
        musicService.getArtistById(id!),
        musicService.getArtistAlbums(id!),
        musicService.getArtistTracks(id!, { limit: 20 }),
      ]);
      setArtist(artistData);
      setAlbums(albumsData.albums);
      setTracks(tracksData.tracks);
    } catch (error) {
      console.error('[ArtistScreen] Error fetching artist:', error);
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

  // Get gradient colors from artist primaryColor or fallback to theme primary
  // 2-stop gradient: primaryColor -> theme background
  const getGradientColors = (): [string, string] => {
    const topColor = artist?.primaryColor
      ? artist.primaryColor
      : theme.colors.primary;
    return [topColor, theme.colors.background];
  };

  const handlePlayAll = () => {
    if (tracks.length > 0) {
      playTrack(tracks[0]);
    }
  };

  const handleTrackPress = (track: Track) => {
    playTrack(track);
  };

  const handleFollow = async () => {
    if (!isAuthenticated) {
      toast.error('You must be logged in to follow artists');
      return;
    }

    if (!artist) return;

    try {
      setIsFollowing(true);
      if (isFollowed) {
        await musicService.unfollowArtist(artist.id);
        setIsFollowed(false);
        toast.success(`Unfollowed ${artist.name}`);
      } else {
        await musicService.followArtist(artist.id);
        setIsFollowed(true);
        toast.success(`Following ${artist.name}`);
      }
    } catch (error: any) {
      console.error('[ArtistScreen] Error following/unfollowing artist:', error);
      toast.error(error?.message || 'Failed to update follow status');
    } finally {
      setIsFollowing(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  if (!artist) {
    return (
      <View style={[styles.errorContainer, { backgroundColor: theme.colors.background }]}>
        <Text style={[styles.errorText, { color: theme.colors.text }]}>Artist not found</Text>
      </View>
    );
  }

  return (
    <>
      <SEO
        title={`${artist.name} - Syra`}
        description={artist.bio || `Listen to ${artist.name}`}
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
            {/* Center - Title and image */}
            <View style={styles.stickyHeaderCenter}>
              <View style={[styles.stickyHeaderImageContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
                {artist.image ? (
                  <Image
                    source={{ uri: artist.image }}
                    style={styles.stickyHeaderImage}
                    resizeMode="cover"
                  />
                ) : (
                  <Ionicons name="person" size={20} color={theme.colors.textSecondary} />
                )}
              </View>
              <Text style={[styles.stickyHeaderTitle, { color: theme.colors.text }]} numberOfLines={1}>
                {artist.name}
              </Text>
            </View>

            {/* Right side - Controls */}
            <View style={styles.stickyHeaderControls}>
              <Pressable
                style={[styles.stickyHeaderPlayButton, { backgroundColor: theme.colors.primary }]}
                onPress={handlePlayAll}
              >
                <Ionicons name="play" size={16} color="#000" />
              </Pressable>
              <Pressable
                style={styles.stickyHeaderControlButton}
                onPress={handleFollow}
                disabled={isFollowing}
              >
                <Ionicons
                  name={isFollowed ? "heart" : "heart-outline"}
                  size={20}
                  color={isFollowed ? theme.colors.primary : theme.colors.text}
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
            {artist.image ? (
              <Image
                source={{ uri: artist.image }}
                style={styles.headerImage}
                resizeMode="cover"
              />
            ) : (
              <View style={[styles.headerPlaceholder, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <Ionicons name="person" size={80} color={theme.colors.textSecondary} />
              </View>
            )}
            {/* Gradient overlay for text readability */}
            <LinearGradient
              colors={['transparent', 'rgba(0, 0, 0, 0.3)', 'rgba(0, 0, 0, 0.7)'] as readonly [string, string, string]}
              locations={[0, 0.6, 1] as readonly [number, number, number]}
              style={styles.headerOverlay}
            />
            {/* Artist Title */}
            <Animated.View style={[styles.titleContainer, headerTitleAnimatedStyle]}>
              <Text style={[styles.artistTitle, { color: '#FFFFFF' }]} numberOfLines={2}>
                {artist.name}
              </Text>
            </Animated.View>
          </Animated.View>

          {/* Content Section with Gradient Background */}
          <LinearGradient
            colors={getGradientColors()}
            locations={[0, 0.2]}
            style={styles.contentSection}
          >
            {/* Artist Info */}
            <View style={styles.infoContainer}>
              <View style={styles.infoHeader}>
                {artist.image && (
                  <Image
                    source={{ uri: artist.image }}
                    style={styles.infoImage}
                    resizeMode="cover"
                  />
                )}
                <View style={styles.infoTextContainer}>
                  {artist.bio && (
                    <Text style={[styles.bio, { color: theme.colors.textSecondary }]} numberOfLines={3}>
                      {artist.bio}
                    </Text>
                  )}
                  <View style={styles.metadataRow}>
                    {artist.genres && artist.genres.length > 0 && (
                      <>
                        <Text style={[styles.metadata, { color: theme.colors.textSecondary }]}>
                          {artist.genres.join(', ')}
                        </Text>
                        {(artist.stats.followers > 0 || artist.stats.albums > 0 || artist.stats.tracks > 0) && (
                          <Text style={[styles.metadataSeparator, { color: theme.colors.textSecondary }]}>•</Text>
                        )}
                      </>
                    )}
                    {artist.stats.followers > 0 && (
                      <>
                        <Text style={[styles.metadata, { color: theme.colors.textSecondary }]}>
                          {artist.stats.followers.toLocaleString()} {artist.stats.followers === 1 ? 'follower' : 'followers'}
                        </Text>
                        {(artist.stats.albums > 0 || artist.stats.tracks > 0) && (
                          <Text style={[styles.metadataSeparator, { color: theme.colors.textSecondary }]}>•</Text>
                        )}
                      </>
                    )}
                    {artist.stats.albums > 0 && (
                      <>
                        <Text style={[styles.metadata, { color: theme.colors.textSecondary }]}>
                          {artist.stats.albums} {artist.stats.albums === 1 ? 'album' : 'albums'}
                        </Text>
                        {artist.stats.tracks > 0 && (
                          <Text style={[styles.metadataSeparator, { color: theme.colors.textSecondary }]}>•</Text>
                        )}
                      </>
                    )}
                    {artist.stats.tracks > 0 && (
                      <Text style={[styles.metadata, { color: theme.colors.textSecondary }]}>
                        {artist.stats.tracks} {artist.stats.tracks === 1 ? 'track' : 'tracks'}
                      </Text>
                    )}
                  </View>
                </View>
              </View>
            </View>

            {/* Playback Controls */}
            <View style={styles.controlsContainer}>
              <Pressable
                style={[styles.playButton, { backgroundColor: theme.colors.primary }]}
                onPress={handlePlayAll}
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
                onPress={handleFollow}
                disabled={isFollowing}
              >
                <Ionicons
                  name={isFollowed ? "heart" : "heart-outline"}
                  size={24}
                  color={isFollowed ? '#1DB954' : theme.colors.text}
                />
              </Pressable>

              <Pressable style={styles.controlButton}>
                <Ionicons name="ellipsis-horizontal" size={24} color={theme.colors.text} />
              </Pressable>
            </View>

            {/* Popular Tracks Section */}
            {tracks.length > 0 && (
              <>
                <View style={styles.sectionHeader}>
                  <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                    Popular
                  </Text>
                </View>
                <View style={styles.trackList}>
                  {tracks.slice(0, 10).map((track, index) => {
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
                  })}
                </View>
              </>
            )}

            {/* Albums Section */}
            {albums.length > 0 && (
              <>
                <View style={styles.sectionHeader}>
                  <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                    Albums
                  </Text>
                </View>
                <View style={styles.albumsGrid}>
                  {albums.map((album) => (
                    <View key={album.id} style={styles.albumGridItem}>
                      <MediaCard
                        title={album.title}
                        subtitle={album.artistName}
                        type="album"
                        imageUri={album.coverArt}
                        onPress={() => router.push(`/album/${album.id}`)}
                      />
                    </View>
                  ))}
                </View>
              </>
            )}

            {/* Empty State */}
            {albums.length === 0 && tracks.length === 0 && (
              <View style={styles.emptyState}>
                <Text style={[styles.emptyStateText, { color: theme.colors.textSecondary }]}>
                  No albums or tracks available
                </Text>
              </View>
            )}
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
    borderRadius: 20,
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
  artistTitle: {
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
  infoImage: {
    width: 64,
    height: 64,
    borderRadius: 32,
  },
  infoTextContainer: {
    flex: 1,
    minWidth: 0,
  },
  bio: {
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
  sectionHeader: {
    paddingHorizontal: 24,
    paddingBottom: 16,
    paddingTop: 8,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    letterSpacing: -0.5,
  },
  trackList: {
    paddingHorizontal: 24,
    gap: 4,
  },
  albumsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
  albumGridItem: {
    paddingHorizontal: 4,
    paddingBottom: 16,
    ...Platform.select({
      web: {
        width: '20%', // 5 columns on desktop
        minWidth: 180,
        maxWidth: 220,
      },
      default: {
        width: '50%', // 2 columns on mobile
      },
    }),
  },
  emptyState: {
    paddingVertical: 48,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  emptyStateText: {
    fontSize: 14,
  },
});

export default ArtistScreen;


