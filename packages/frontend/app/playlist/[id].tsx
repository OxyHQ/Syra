import React, { useState } from 'react';
import { StyleSheet, View, Text, Pressable, Image, ScrollView, Platform } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import Animated, {
  interpolate,
  useAnimatedRef,
  useAnimatedStyle,
  useScrollViewOffset,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '@oxyhq/bloom/theme';
import { musicService } from '@/services/musicService';
import { Track } from '@syra/shared-types';
import { Ionicons } from '@expo/vector-icons';
import { usePlayerStore } from '@/stores/playerStore';
import { useQueueStore } from '@/stores/queueStore';
import SEO from '@/components/SEO';
import { TrackRow } from '@/components/TrackRow';
import { MediaHeaderSkeleton } from '@/components/skeletons';
import { formatTotalDuration } from '@/utils/musicUtils';
import { useLibrary, useToggleSavePlaylist } from '@/hooks/useLibrary';
import { webViewStyle } from '@/utils/webStyles';
import { pickCatalogImageUrl } from '@/utils/pickImage';
import { toast } from '@/lib/sonner';
import { useOxy } from '@oxyhq/services';
import { AmbientArtworkTheme } from '@/components/AmbientArtworkTheme';
import { useArtworkSeed } from '@/hooks/useArtworkSeed';

const HEADER_HEIGHT = 400;

type PlaylistData = NonNullable<Awaited<ReturnType<typeof musicService.getPlaylistById>>>;

/**
 * Playlist Screen
 * Displays playlist details with parallax header, gradient overlay, and track list
 */
const PlaylistScreen: React.FC = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const { playTrackList, currentTrack, isPlaying } = usePlayerStore();
  const { shuffle, toggleShuffle } = useQueueStore();
  const { canUsePrivateApi, isPrivateApiPending } = useOxy();
  const catalogIdentity = canUsePrivateApi ? 'auth' : 'guest';

  const { isPlaylistSaved } = useLibrary();
  const toggleSave = useToggleSavePlaylist();
  const isSaved = id ? isPlaylistSaved(id) : false;
  const [isDownloaded, setIsDownloaded] = useState(false);
  const { seed, activate: activateSeed, deactivate: deactivateSeed } = useArtworkSeed();

  const handleToggleSave = () => {
    if (!id) {
      return;
    }
    toggleSave.mutate({ id, next: !isSaved });
  };

  const { data, isLoading } = useQuery({
    queryKey: ['playlist', id, catalogIdentity],
    queryFn: async () => {
      const [playlistData, tracksData] = await Promise.all([
        musicService.getPlaylistById(id),
        musicService.getPlaylistTracks(id),
      ]);
      return { playlist: playlistData, tracks: tracksData.tracks };
    },
    enabled: !!id && !isPrivateApiPending,
  });

  const playlist = data?.playlist ?? null;
  const tracks = data?.tracks ?? [];
  const canPlay = tracks.length > 0;
  const isCatalogLoading = isPrivateApiPending || isLoading;

  const handlePlayPlaylist = () => {
    if (!canPlay) {
      toast.info('No playable tracks available');
      return;
    }

    playTrackList(tracks, 0, {
      type: 'playlist',
      id,
      name: playlist?.name,
    });
  };

  const handleTrackPress = (track: Track) => {
    const startIndex = tracks.findIndex((item) => item.id === track.id);
    playTrackList(tracks, startIndex >= 0 ? startIndex : 0, {
      type: 'playlist',
      id,
      name: playlist?.name,
    });
  };

  if (isCatalogLoading) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <MediaHeaderSkeleton />
        </ScrollView>
      </View>
    );
  }

  if (!playlist) {
    return (
      <View style={[styles.errorContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <Text style={[styles.errorText, { color: theme.colors.text }]}>Playlist not found</Text>
      </View>
    );
  }

  const playlistHeroImage = pickCatalogImageUrl(undefined, playlist.coverArt, 'hero', playlist.coverArtSizes);

  // Hover the cover → extract its dominant colour → re-theme the playlist's
  // ambient surfaces. `PlaylistView` reads the scoped theme via `useTheme()`
  // inside the ambient region, so the hero + tracklist ease into the artwork
  // palette; leaving the cover restores the app preset. Native is a no-op.
  return (
    <AmbientArtworkTheme seed={seed}>
      <PlaylistView
        playlist={playlist}
        tracks={tracks}
        heroImage={playlistHeroImage}
        currentTrackId={currentTrack?.id}
        isPlaying={isPlaying}
        isSaved={isSaved}
        isDownloaded={isDownloaded}
        setIsDownloaded={setIsDownloaded}
        canPlay={canPlay}
        shuffle={shuffle}
        toggleShuffle={toggleShuffle}
        onCoverHoverIn={() => id && activateSeed(id, playlistHeroImage)}
        onCoverHoverOut={deactivateSeed}
        onPlayPlaylist={handlePlayPlaylist}
        onToggleSave={handleToggleSave}
        onTrackPress={handleTrackPress}
      />
    </AmbientArtworkTheme>
  );
};

interface PlaylistViewProps {
  playlist: PlaylistData;
  tracks: Track[];
  heroImage: string | undefined;
  currentTrackId: string | undefined;
  isPlaying: boolean;
  isSaved: boolean;
  isDownloaded: boolean;
  setIsDownloaded: (next: boolean) => void;
  canPlay: boolean;
  shuffle: 'on' | 'off';
  toggleShuffle: () => void;
  onCoverHoverIn: () => void;
  onCoverHoverOut: () => void;
  onPlayPlaylist: () => void;
  onToggleSave: () => void;
  onTrackPress: (track: Track) => void;
}

/**
 * The playlist's ambient region. Reads `useTheme()` INSIDE `<AmbientArtworkTheme>`
 * so its surfaces re-theme to the artwork seed while hovering the cover, then
 * revert to the app preset on hover-out. Owns the parallax scroll hooks.
 */
const PlaylistView: React.FC<PlaylistViewProps> = ({
  playlist,
  tracks,
  heroImage,
  currentTrackId,
  isPlaying,
  isSaved,
  isDownloaded,
  setIsDownloaded,
  canPlay,
  shuffle,
  toggleShuffle,
  onCoverHoverIn,
  onCoverHoverOut,
  onPlayPlaylist,
  onToggleSave,
  onTrackPress,
}) => {
  const theme = useTheme();
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollOffset = useScrollViewOffset(scrollRef);

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

  const gradientColors: readonly [string, string, string] = [
    playlist.primaryColor ?? theme.colors.primary,
    playlist.secondaryColor ?? theme.colors.backgroundSecondary,
    theme.colors.backgroundSecondary,
  ];

  const totalDurationFormatted = playlist.totalDuration
    ? formatTotalDuration(playlist.totalDuration)
    : '';

  const playlistStickyImage = pickCatalogImageUrl(undefined, playlist.coverArt, 'icon', playlist.coverArtSizes);
  const playlistInfoImage = pickCatalogImageUrl(undefined, playlist.coverArt, 'smallArtwork', playlist.coverArtSizes);

  return (
    <>
      <SEO
        title={`${playlist.name} - Syra`}
        description={playlist.description || `Listen to ${playlist.name}`}
      />
      <View style={[styles.container, { backgroundColor: theme.colors.backgroundSecondary }]}>
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
                {playlistStickyImage ? (
                  <Image
                    source={{ uri: playlistStickyImage }}
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
                style={[
                  styles.stickyHeaderPlayButton,
                  { backgroundColor: theme.colors.primary },
                  !canPlay && styles.disabledControl,
                ]}
                onPress={onPlayPlaylist}
                disabled={!canPlay}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canPlay }}
              >
                <Ionicons name="play" size={16} color={theme.colors.primaryForeground} />
              </Pressable>
              <Pressable
                style={styles.stickyHeaderControlButton}
                onPress={onToggleSave}
                accessibilityRole="button"
                accessibilityState={{ selected: isSaved }}
                accessibilityLabel={isSaved ? 'Remove from your library' : 'Save to your library'}
              >
                <Ionicons
                  name={isSaved ? "heart" : "heart-outline"}
                  size={20}
                  color={isSaved ? theme.colors.primary : theme.colors.text}
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
            {/* Cover — hover (web) / focus to tint the ambient region */}
            <Pressable
              style={StyleSheet.absoluteFill}
              onHoverIn={onCoverHoverIn}
              onHoverOut={onCoverHoverOut}
              onFocus={onCoverHoverIn}
              onBlur={onCoverHoverOut}
              accessibilityRole="image"
              accessibilityLabel={`${playlist.name} cover art`}
            >
              {heroImage ? (
                <Image
                  source={{ uri: heroImage }}
                  style={styles.headerImage}
                  resizeMode="cover"
                />
              ) : (
                <View style={[styles.headerPlaceholder, { backgroundColor: theme.colors.backgroundSecondary }]}>
                  <Ionicons name="musical-notes" size={80} color={theme.colors.textSecondary} />
                </View>
              )}
            </Pressable>
            {/* Gradient overlay for text readability */}
            <LinearGradient
              colors={['transparent', 'rgba(0, 0, 0, 0.3)', 'rgba(0, 0, 0, 0.7)'] as readonly [string, string, string]}
              locations={[0, 0.6, 1] as readonly [number, number, number]}
              pointerEvents="none"
              style={styles.headerOverlay}
            />
            {/* Playlist Title */}
            <Animated.View pointerEvents="none" style={[styles.titleContainer, headerTitleAnimatedStyle]}>
              <Text style={[styles.playlistTitle, { color: '#FFFFFF' }]} numberOfLines={2}>
                {playlist.name}
              </Text>
            </Animated.View>
          </Animated.View>

          {/* Content Section with Gradient Background */}
          <LinearGradient
            colors={gradientColors}
            locations={[0, 0.35, 1]}
            style={styles.contentSection}
          >
            {/* Playlist Info */}
            <View style={styles.infoContainer}>
              <View style={styles.infoHeader}>
                {playlistInfoImage && (
                  <Image
                    source={{ uri: playlistInfoImage }}
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
                style={[
                  styles.playButton,
                  { backgroundColor: theme.colors.primary },
                  !canPlay && styles.disabledControl,
                ]}
                onPress={onPlayPlaylist}
                disabled={!canPlay}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canPlay }}
              >
                <View style={styles.playButtonInner}>
                  <Ionicons name="play" size={24} color={theme.colors.primaryForeground} />
                </View>
              </Pressable>

              <Pressable
                style={styles.controlButton}
                onPress={toggleShuffle}
                accessibilityRole="button"
                accessibilityState={{ selected: shuffle === 'on' }}
                accessibilityLabel={shuffle === 'on' ? 'Turn shuffle off' : 'Turn shuffle on'}
              >
                <Ionicons
                  name="shuffle"
                  size={22}
                  color={shuffle === 'on' ? theme.colors.primary : theme.colors.text}
                />
              </Pressable>

              <Pressable
                style={styles.controlButton}
                onPress={onToggleSave}
                accessibilityRole="button"
                accessibilityState={{ selected: isSaved }}
                accessibilityLabel={isSaved ? 'Remove from your library' : 'Save to your library'}
              >
                <Ionicons
                  name={isSaved ? "heart" : "heart-outline"}
                  size={24}
                  color={isSaved ? theme.colors.primary : theme.colors.text}
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
                  const isCurrentTrack = currentTrackId === track.id;
                  const isTrackPlaying = isCurrentTrack && isPlaying;

                  return (
                    <TrackRow
                      key={track.id}
                      track={track}
                      index={index}
                      isCurrentTrack={isCurrentTrack}
                      isTrackPlaying={isTrackPlaying}
                      onPress={() => onTrackPress(track)}
                      onPlayPress={() => onTrackPress(track)}
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
      web: webViewStyle({
        position: 'sticky',
      }),
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
  disabledControl: {
    opacity: 0.5,
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
    ...StyleSheet.absoluteFill,
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
