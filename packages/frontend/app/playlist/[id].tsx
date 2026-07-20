import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View, Text, Pressable, Image, ScrollView, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import Animated, {
  interpolate,
  useAnimatedRef,
  useAnimatedStyle,
  useScrollViewOffset,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme, useAmbientTheme } from '@oxyhq/bloom/theme';
import { musicService } from '@/services/musicService';
import { Track } from '@syra/shared-types';
import { Ionicons } from '@expo/vector-icons';
import { usePlayerStore } from '@/stores/playerStore';
import { useQueueStore } from '@/stores/queueStore';
import SEO from '@/components/SEO';
import { TrackRow } from '@/components/TrackRow';
import { MediaHeaderSkeleton } from '@/components/skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { formatTotalDuration } from '@/utils/musicUtils';
import { useLibrary, useToggleSavePlaylist } from '@/hooks/useLibrary';
import { webViewStyle } from '@/utils/webStyles';
import { pickCatalogImageUrl } from '@/utils/pickImage';
import { isNotFoundError } from '@/utils/api';
import { toast } from '@/lib/sonner';
import { useAuthGate } from '@/hooks/useAuthGate';
import { CATALOG_QUERY_KEYS } from '@/hooks/useLibraryCollections';
import { useOxy } from '@oxyhq/services';
import { PlaylistActionsSheet } from '@/components/playlist/PlaylistActionsSheet';
import { TrackActionsSheet } from '@/components/playlist/TrackActionsSheet';

const HEADER_HEIGHT = 400;

type PlaylistData = NonNullable<Awaited<ReturnType<typeof musicService.getPlaylistById>>>;

/**
 * Playlist Screen
 * Displays playlist details with parallax header, gradient overlay, and track list
 */
const PlaylistScreen: React.FC = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const { playTrackList, currentTrack, isPlaying } = usePlayerStore();
  const { shuffle, toggleShuffle } = useQueueStore();
  const gate = useAuthGate();

  const { isPlaylistSaved } = useLibrary();
  const toggleSave = useToggleSavePlaylist();
  const isSaved = id ? isPlaylistSaved(id) : false;
  const [isDownloaded, setIsDownloaded] = useState(false);

  const handleToggleSave = () => {
    if (!id) {
      return;
    }
    toggleSave.mutate({ id, next: !isSaved });
  };

  // A deleted playlist has no screen left to show; fall back to the library.
  const handleDeleted = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/library');
    }
  }, [router]);

  // The playlist object and its tracks are separate queries so the playlist
  // entry is the SAME cache entry the library sidebar hydrates
  // (`CATALOG_QUERY_KEYS.playlist`) — opening this screen reuses what the
  // sidebar already fetched, and vice versa, instead of keeping two copies.
  const playlistQuery = useQuery({
    queryKey: CATALOG_QUERY_KEYS.playlist(id, gate.catalogIdentity),
    queryFn: () => musicService.getPlaylistById(id),
    enabled: !!id && gate.isResolved,
  });

  const tracksQuery = useQuery({
    queryKey: CATALOG_QUERY_KEYS.playlistTracks(id, gate.catalogIdentity),
    queryFn: async () => (await musicService.getPlaylistTracks(id)).tracks,
    enabled: !!id && gate.isResolved,
  });

  const playlist = playlistQuery.data ?? null;
  const tracks = tracksQuery.data ?? [];
  const canPlay = tracks.length > 0;
  const isCatalogLoading = gate.isResolving || playlistQuery.isLoading || tracksQuery.isLoading;

  const playlistHeroImage = playlist
    ? pickCatalogImageUrl(undefined, playlist.coverArt, 'hero', playlist.coverArtSizes)
    : undefined;

  // VIEW MODE: theme the WHOLE app from the playlist's server-extracted cover
  // colours ON VIEW and restore the default on leave. All theming lives in Bloom —
  // this thin effect only feeds the cover colours to Bloom's ambient store
  // (consumed internally by the root provider). Runs before the early returns so
  // the hook order stays stable; no-ops until the playlist loads.
  const { setAmbient, clearAmbient } = useAmbientTheme();
  const playlistPrimaryColor = playlist?.primaryColor;
  const playlistSecondaryColor = playlist?.secondaryColor;
  useEffect(() => {
    if (playlistPrimaryColor) {
      setAmbient(playlistPrimaryColor, { secondary: playlistSecondaryColor });
    }
    return () => clearAmbient();
  }, [playlistPrimaryColor, playlistSecondaryColor, setAmbient, clearAmbient]);

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

  // Terminal auth failure — the session never resolved within the gate's bound.
  // Rendered as an error the user can act on, never as an endless skeleton.
  if (gate.isTimedOut) {
    return (
      <EmptyState
        containerStyle={{ backgroundColor: theme.colors.backgroundSecondary }}
        icon={{ name: 'cloud-offline-outline' }}
        error={{
          title: 'Session unavailable',
          message: 'We could not confirm your session. Check your connection and try again.',
          onRetry: async () => {
            gate.retry();
          },
        }}
      />
    );
  }

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

  // A failed request is not a missing playlist: only a 404 falls through to the
  // "not found" branch below, everything else is a load failure with a retry.
  if ((playlistQuery.isError || tracksQuery.isError) && !isNotFoundError(playlistQuery.error)) {
    return (
      <EmptyState
        containerStyle={{ backgroundColor: theme.colors.backgroundSecondary }}
        icon={{ name: 'cloud-offline-outline' }}
        error={{
          title: 'Could not load this playlist',
          message: 'Something went wrong while loading this playlist. Please try again.',
          onRetry: async () => {
            await Promise.all([playlistQuery.refetch(), tracksQuery.refetch()]);
          },
        }}
      />
    );
  }

  if (!playlist) {
    return (
      <EmptyState
        containerStyle={{ backgroundColor: theme.colors.backgroundSecondary }}
        icon={{ name: 'musical-notes-outline' }}
        title="Playlist not found"
        subtitle="This playlist may have been deleted or is private."
      />
    );
  }

  // The whole app is themed from this playlist's cover ON VIEW (see the ambient
  // effect above). No per-screen theme wrapper and no cover-hover theming —
  // `PlaylistView` reads the already-themed app theme.
  return (
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
      onPlayPlaylist={handlePlayPlaylist}
      onToggleSave={handleToggleSave}
      onTrackPress={handleTrackPress}
      onDeleted={handleDeleted}
    />
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
  onPlayPlaylist: () => void;
  onToggleSave: () => void;
  onTrackPress: (track: Track) => void;
  onDeleted: () => void;
}

/**
 * The playlist's presentational view. Reads the app theme via `useTheme()`; the
 * app is already themed from the playlist cover on view (see the ambient effect in
 * `PlaylistScreen`), so the hero + tracklist reflect the artwork palette with no
 * cover-hover handling here. Owns the parallax scroll hooks.
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
  onPlayPlaylist,
  onToggleSave,
  onTrackPress,
  onDeleted,
}) => {
  const theme = useTheme();
  const { user } = useOxy();
  const [showPlaylistActions, setShowPlaylistActions] = useState(false);
  const [trackActionsFor, setTrackActionsFor] = useState<Track | null>(null);
  // Mirrors the backend's `canEditPlaylist` (owner or editor collaborator) so a
  // viewer is never offered a removal that is certain to 403.
  const canEditPlaylist = user?.id === playlist.ownerOxyUserId
    || (playlist.collaborators ?? []).some(
      (collaborator) => collaborator.oxyUserId === user?.id && collaborator.role === 'editor',
    );
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

  // Cover-derived hero gradient, same shape as the album/podcast screens: both
  // colour stops fall back to the neutral secondary background (never the vivid
  // brand accent), so a cover with no extracted colours reads as a plain hero.
  const gradientColors: readonly [string, string, string] = [
    playlist.primaryColor ?? theme.colors.backgroundSecondary,
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
              <Pressable
                style={styles.stickyHeaderControlButton}
                onPress={() => setShowPlaylistActions(true)}
                accessibilityRole="button"
                accessibilityLabel="More options for this playlist"
              >
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
            {/* Cover (the app is themed from it on view, not on hover) */}
            <View
              style={StyleSheet.absoluteFill}
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
            </View>
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

              <Pressable
                style={styles.controlButton}
                onPress={() => setShowPlaylistActions(true)}
                accessibilityRole="button"
                accessibilityLabel="More options for this playlist"
              >
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
                      onMorePress={() => setTrackActionsFor(track)}
                    />
                  );
                })
              )}
            </View>
          </LinearGradient>
        </Animated.ScrollView>
      </View>

      <PlaylistActionsSheet
        visible={showPlaylistActions}
        onClose={() => setShowPlaylistActions(false)}
        playlist={playlist}
        onDeleted={onDeleted}
      />

      {trackActionsFor && (
        <TrackActionsSheet
          visible
          onClose={() => setTrackActionsFor(null)}
          track={trackActionsFor}
          removeFrom={
            canEditPlaylist
              ? { playlistId: playlist.id, playlistName: playlist.name }
              : undefined
          }
        />
      )}
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
