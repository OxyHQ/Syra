import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, ScrollView, Pressable, Platform } from 'react-native';
import { webViewStyle, webDimension } from '@/utils/webStyles';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { useMediaQuery } from 'react-responsive';
import { usePlayerStore } from '@/stores/playerStore';
import { useQueueStore } from '@/stores/queueStore';
import { useUIStore } from '@/stores/uiStore';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { musicService } from '@/services/musicService';
import { Album, Artist } from '@syra/shared-types';
import Avatar from '@/components/Avatar';
import { LyricsView } from '@/components/LyricsView';
import { pickImageUrl } from '@/utils/pickImage';
import { useLibrary, useToggleLikeTrack } from '@/hooks/useLibrary';

/**
 * Now Playing Sidebar Component
 * Shows large background image, track info, and cards for artist, credits, queue
 * Collapsible and hidden on mobile/tablet
 */
export const NowPlaying: React.FC = () => {
  const theme = useTheme();
  const router = useRouter();
  const isDesktop = useMediaQuery({ minWidth: 1024 });
  const setNowPlayingVisible = useUIStore(s => s.setNowPlayingVisible);
  const fullscreenPanel = useUIStore(s => s.fullscreenPanel);
  const toggleFullscreen = useUIStore(s => s.toggleFullscreen);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const playFromQueue = usePlayerStore(s => s.playFromQueue);
  const queue = useQueueStore(s => s.queue);
  const { isTrackLiked } = useLibrary();
  const toggleLike = useToggleLikeTrack();
  const isLiked = currentTrack ? isTrackLiked(currentTrack.id) : false;
  const isFullscreen = fullscreenPanel === 'nowPlaying';
  const [album, setAlbum] = useState<Album | null>(null);
  const [artist, setArtist] = useState<Artist | null>(null);
  const [lyricsExpanded, setLyricsExpanded] = useState(false);
  const nextTracks = queue?.tracks.slice(Math.max((queue.current ?? -1) + 1, 0)) ?? [];

  // Fetch album and artist details if track exists
  useEffect(() => {
    const fetchDetails = async () => {
      if (currentTrack) {
        try {
          const promises: Promise<any>[] = [];
          
          if (currentTrack.albumId) {
            promises.push(musicService.getAlbumById(currentTrack.albumId).then(data => setAlbum(data)));
          }
          
          if (currentTrack.artistId) {
            promises.push(musicService.getArtistById(currentTrack.artistId).then(data => setArtist(data)));
          }
          
          await Promise.all(promises);
        } catch (error) {
          console.error('[NowPlaying] Error fetching details:', error);
        }
      } else {
        setAlbum(null);
        setArtist(null);
      }
    };

    fetchDetails();
  }, [currentTrack?.id]);

  const handleToggleLike = () => {
    if (!currentTrack) {
      return;
    }
    toggleLike.mutate({ id: currentTrack.id, next: !isLiked });
  };

  // Use album cover or artist image as background
  const backgroundImage =
    pickImageUrl(currentTrack?.images, currentTrack?.coverArt, 1000, currentTrack?.coverArtSizes) ||
    pickImageUrl(undefined, album?.coverArt, 1000, album?.coverArtSizes) ||
    pickImageUrl(artist?.images, artist?.image, 1000, artist?.imageSizes);

  // Hide on mobile/tablet only (after hooks, so hook order stays stable)
  if (!isDesktop) {
    return null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.wrapper}>
          {/* Header with buttons */}
          <View style={styles.header}>
            <View style={styles.headerButtons}>
              <Pressable
                onPress={() => toggleFullscreen('nowPlaying')}
                style={styles.headerButton}
              >
                <Ionicons
                  name={isFullscreen ? 'contract' : 'expand'}
                  size={20}
                  color="#fff"
                />
              </Pressable>
              {!isFullscreen && (
                <Pressable
                  onPress={() => setNowPlayingVisible(false)}
                  style={styles.headerButton}
                >
                  <Octicons
                    name="sidebar-collapse"
                    size={20}
                    color="#fff"
                  />
                </Pressable>
              )}
            </View>
          </View>

          {/* Fixed Background Image */}
          {backgroundImage ? (
            <View style={styles.backgroundContainer}>
              <ExpoImage
                source={{ uri: backgroundImage }}
                style={styles.backgroundImage}
                contentFit="cover"
              />
              <LinearGradient
                colors={['transparent', 'rgba(0,0,0,0.8)']}
                locations={[0.4, 1]}
                style={styles.gradientOverlay}
              />
            </View>
          ) : (
            <View style={[styles.backgroundPlaceholder, { backgroundColor: theme.colors.backgroundTertiary }]}>
              <Ionicons name="musical-notes" size={80} color={theme.colors.textSecondary} />
            </View>
          )}

          {/* Scrollable Content Overlay */}
          <ScrollView 
            style={styles.scrollView} 
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.scrollContent}
          >
            {/* Spacer to push content down initially */}
            <View style={styles.topSpacer} />
            
            {/* Now Playing Content */}
            {currentTrack ? (
              <View style={styles.nowPlayingContainer}>
                {/* Track Info at Bottom */}
                <View style={styles.trackInfoSection}>
                  <View style={styles.trackInfoText}>
                    <Text
                      style={[styles.trackTitle, { color: '#fff' }]}
                      numberOfLines={2}
                    >
                      {currentTrack.title}
                    </Text>
                    <Pressable
                      onPress={() => router.push(`/artist/${currentTrack.artistId}`)}
                      style={styles.artistPressable}
                    >
                      <Text
                        style={[styles.trackArtist, { color: '#fff' }]}
                        numberOfLines={1}
                      >
                        {currentTrack.artistName}
                      </Text>
                    </Pressable>
                  </View>
                  <Pressable
                    onPress={handleToggleLike}
                    style={styles.likeButton}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isLiked }}
                    accessibilityLabel={isLiked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
                  >
                    <Ionicons
                      name={isLiked ? 'heart' : 'heart-outline'}
                      size={28}
                      color={isLiked ? theme.colors.primary : '#fff'}
                    />
                  </Pressable>
                </View>

                {/* About This Artist Card */}
                {artist && (
                  <View style={[styles.card, { backgroundColor: theme.colors.backgroundTertiary }]}>
                    <View style={styles.cardHeader}>
                      <Text style={[styles.cardTitle, { color: theme.colors.text }]}>About this artist</Text>
                    </View>
                    <Pressable
                      onPress={() => router.push(`/artist/${artist.id}`)}
                      style={styles.artistCard}
                    >
                      {(artist.image || artist.images?.length) ? (
                        <Avatar source={pickImageUrl(artist.images, artist.image, 80, artist.imageSizes)} size={80} />
                      ) : (
                        <View style={[styles.artistImagePlaceholder, { backgroundColor: theme.colors.background }]}>
                          <Ionicons name="person" size={40} color={theme.colors.textSecondary} />
                        </View>
                      )}
                      <View style={styles.artistCardInfo}>
                        <Text style={[styles.artistCardName, { color: theme.colors.text }]} numberOfLines={1}>
                          {artist.name}
                        </Text>
                        {artist.genres && artist.genres.length > 0 && (
                          <Text style={[styles.artistCardGenre, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                            {artist.genres[0]}
                          </Text>
                        )}
                      </View>
                    </Pressable>
                  </View>
                )}

                {/* Lyrics Card */}
                <View style={[styles.card, { backgroundColor: theme.colors.backgroundTertiary }]}>
                  <Pressable
                    style={styles.cardHeader}
                    onPress={() => setLyricsExpanded((v) => !v)}
                    accessibilityRole="button"
                    accessibilityLabel={lyricsExpanded ? 'Hide lyrics' : 'Show lyrics'}
                  >
                    <View style={styles.cardHeaderRow}>
                      <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Lyrics</Text>
                      <Ionicons
                        name={lyricsExpanded ? 'chevron-up' : 'chevron-down'}
                        size={16}
                        color={theme.colors.textSecondary}
                      />
                    </View>
                  </Pressable>
                  {lyricsExpanded && (
                    <LyricsView trackId={currentTrack.id} />
                  )}
                </View>

                {/* Credits Card */}
                {album && (
                  <View style={[styles.card, { backgroundColor: theme.colors.backgroundTertiary }]}>
                    <View style={styles.cardHeader}>
                      <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Credits</Text>
                    </View>
                    <View style={styles.creditsContent}>
                      <View style={styles.creditRow}>
                        <Text style={[styles.creditLabel, { color: theme.colors.textSecondary }]}>Album</Text>
                        <Pressable
                          onPress={() => router.push(`/album/${album.id}`)}
                          style={styles.creditValuePressable}
                        >
                          <Text style={[styles.creditValue, { color: theme.colors.text }]} numberOfLines={1}>
                            {album.title}
                          </Text>
                        </Pressable>
                      </View>
                      <View style={styles.creditRow}>
                        <Text style={[styles.creditLabel, { color: theme.colors.textSecondary }]}>Artist</Text>
                        <Pressable
                          onPress={() => router.push(`/artist/${album.artistId}`)}
                          style={styles.creditValuePressable}
                        >
                          <Text style={[styles.creditValue, { color: theme.colors.text }]} numberOfLines={1}>
                            {album.artistName}
                          </Text>
                        </Pressable>
                      </View>
                      {album.releaseDate && (
                        <View style={styles.creditRow}>
                          <Text style={[styles.creditLabel, { color: theme.colors.textSecondary }]}>Released</Text>
                          <Text style={[styles.creditValue, { color: theme.colors.text }]}>
                            {new Date(album.releaseDate).getFullYear()}
                          </Text>
                        </View>
                      )}
                      {album.label && (
                        <View style={styles.creditRow}>
                          <Text style={[styles.creditLabel, { color: theme.colors.textSecondary }]}>Label</Text>
                          <Text style={[styles.creditValue, { color: theme.colors.text }]} numberOfLines={1}>
                            {album.label}
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                )}

                {/* Next in Queue Card */}
                <View style={[styles.card, { backgroundColor: theme.colors.backgroundTertiary }]}>
                  <View style={styles.cardHeader}>
                    <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Next in queue</Text>
                  </View>
                  {nextTracks.length > 0 ? (
                    <View style={styles.queueContent}>
                      {nextTracks.slice(0, 5).map((track, index) => (
                        <Pressable
                          key={track.id}
                          onPress={() => playFromQueue((queue?.current ?? -1) + index + 1)}
                          style={styles.queueItem}
                        >
                          {(track.coverArt || track.images?.length) ? (
                            <ExpoImage
                              source={{ uri: pickImageUrl(track.images, track.coverArt, 80, track.coverArtSizes) }}
                              style={styles.queueItemImage}
                              contentFit="cover"
                            />
                          ) : (
                            <View style={[styles.queueItemImagePlaceholder, { backgroundColor: theme.colors.background }]}>
                              <Ionicons name="musical-notes" size={16} color={theme.colors.textSecondary} />
                            </View>
                          )}
                          <View style={styles.queueItemInfo}>
                            <Text style={[styles.queueItemTitle, { color: theme.colors.text }]} numberOfLines={1}>
                              {track.title}
                            </Text>
                            <Text style={[styles.queueItemArtist, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                              {track.artistName}
                            </Text>
                          </View>
                        </Pressable>
                      ))}
                    </View>
                  ) : (
                    <View style={styles.emptyQueue}>
                      <Text style={[styles.emptyQueueText, { color: theme.colors.textSecondary }]}>
                        Your queue is empty
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            ) : (
              <View style={styles.placeholder}>
                <Ionicons name="musical-notes-outline" size={48} color={theme.colors.textSecondary} style={styles.placeholderIcon} />
                <Text style={[styles.placeholderText, { color: theme.colors.textSecondary }]}>
                  No track playing
                </Text>
                <Text style={[styles.placeholderSubtext, { color: theme.colors.textSecondary }]}>
                  Start playing a song to see it here
                </Text>
              </View>
            )}
          </ScrollView>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  // `overflowY` is a react-native-web value; the panel only scrolls on web.
  container: webViewStyle({
    height: '100%',
    overflowY: 'auto',
    ...Platform.select({
      default: {
        flex: 1,
      },
      web: {
        width: '100%',
      },
    }),
  }),
  wrapper: {
    flex: 1,
    position: 'relative',
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    padding: 12,
    alignItems: 'flex-end',
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  headerButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  backgroundContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
  },
  backgroundImage: {
    width: '100%',
    height: '100%',
  },
  gradientOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '100%',
  },
  backgroundPlaceholder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollView: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  scrollContent: {
    paddingBottom: 100,
  },
  topSpacer: {
    ...Platform.select({
      web: {
        // Viewport minus top bar and approximate track info height.
        height: webDimension('calc(100vh - 64px - 200px)'),
      },
      default: {
        height: 400,
      },
    }),
  },
  nowPlayingContainer: {
    width: '100%',
  },
  trackInfoSection: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
    padding: 20,
    paddingBottom: 24,
    marginBottom: 16,
    minWidth: 0, // Prevent a long unbroken string from expanding the panel
  },
  trackInfoText: {
    flex: 1,
    minWidth: 0,
  },
  likeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  trackTitle: {
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 8,
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  artistPressable: {
    minWidth: 0, // Let numberOfLines ellipsize within the panel width
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  trackArtist: {
    fontSize: 18,
    fontWeight: '600',
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  card: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 8,
    padding: 16,
  },
  cardHeader: {
    marginBottom: 12,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  artistCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  artistImagePlaceholder: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artistCardInfo: {
    flex: 1,
    minWidth: 0,
  },
  artistCardName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  artistCardGenre: {
    fontSize: 14,
  },
  creditsContent: {
    gap: 12,
  },
  creditRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  creditLabel: {
    fontSize: 13,
    fontWeight: '500',
    minWidth: 70,
  },
  creditValuePressable: {
    flex: 1,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  creditValue: {
    fontSize: 13,
    textAlign: 'right',
  },
  queueContent: {
    gap: 8,
  },
  queueItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 6,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  queueItemImage: {
    width: 48,
    height: 48,
    borderRadius: 4,
    overflow: 'hidden',
  },
  queueItemImagePlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  queueItemInfo: {
    flex: 1,
    minWidth: 0,
  },
  queueItemTitle: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 2,
  },
  queueItemArtist: {
    fontSize: 13,
  },
  emptyQueue: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  emptyQueueText: {
    fontSize: 14,
  },
  placeholder: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 200,
  },
  placeholderIcon: {
    marginBottom: 16,
    opacity: 0.5,
  },
  placeholderText: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  placeholderSubtext: {
    fontSize: 13,
    textAlign: 'center',
    opacity: 0.7,
  },
});
