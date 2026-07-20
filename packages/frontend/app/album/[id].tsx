import React, { useState, useEffect } from 'react';
import { StyleSheet, View, ScrollView, Text, Pressable, Image, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTheme, useAmbientTheme } from '@oxyhq/bloom/theme';
import { musicService } from '@/services/musicService';
import { Track } from '@syra/shared-types';
import { Ionicons } from '@expo/vector-icons';
import { usePlayerStore } from '@/stores/playerStore';
import { useQueueStore } from '@/stores/queueStore';
import SEO from '@/components/SEO';
import Avatar from '@/components/Avatar';
import { MediaHeaderSkeleton } from '@/components/skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { formatDuration, formatTotalDuration } from '@/utils/musicUtils';
import { useLibrary, useToggleSaveAlbum, useToggleLikeTrack } from '@/hooks/useLibrary';
import { LinearGradient } from 'expo-linear-gradient';
import { pickCatalogImageUrl } from '@/utils/pickImage';
import { isNotFoundError } from '@/utils/api';
import { toast } from '@/lib/sonner';
import { useAuthGate } from '@/hooks/useAuthGate';
import { CATALOG_QUERY_KEYS } from '@/hooks/useLibraryCollections';
import { AddToPlaylistSheet } from '@/components/playlist/AddToPlaylistSheet';
import { TrackActionsSheet } from '@/components/playlist/TrackActionsSheet';

/**
 * Album Screen
 * Displays album details, tracks, and playback controls
 */
const AlbumScreen: React.FC = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const { playTrackList, currentTrack, isPlaying } = usePlayerStore();
  const { shuffle, toggleShuffle } = useQueueStore();
  const gate = useAuthGate();

  const { isAlbumSaved, isTrackLiked } = useLibrary();
  const toggleSave = useToggleSaveAlbum();
  const toggleLike = useToggleLikeTrack();
  const isSaved = id ? isAlbumSaved(id) : false;
  const [isDownloaded, setIsDownloaded] = useState(false);

  const handleToggleSave = () => {
    if (!id) {
      return;
    }
    toggleSave.mutate({ id, next: !isSaved });
  };

  const handleToggleTrackLike = (track: Track, liked: boolean) => {
    toggleLike.mutate({ id: track.id, next: !liked, track });
  };

  // The album object and its tracks are separate queries so the album entry is
  // the SAME cache entry the library sidebar hydrates
  // (`CATALOG_QUERY_KEYS.album`) — opening this screen reuses what the sidebar
  // already fetched, and vice versa, instead of keeping two copies.
  const albumQuery = useQuery({
    queryKey: CATALOG_QUERY_KEYS.album(id, gate.catalogIdentity),
    queryFn: () => musicService.getAlbumById(id),
    enabled: !!id && gate.isResolved,
  });

  const tracksQuery = useQuery({
    queryKey: CATALOG_QUERY_KEYS.albumTracks(id, gate.catalogIdentity),
    queryFn: async () => {
      const { tracks: albumTracks } = await musicService.getAlbumTracks(id);
      return albumTracks.sort((a, b) => (a.trackNumber || 0) - (b.trackNumber || 0));
    },
    enabled: !!id && gate.isResolved,
  });

  const album = albumQuery.data ?? null;
  const tracks = tracksQuery.data ?? [];
  const canPlay = tracks.length > 0;
  const isCatalogLoading = gate.isResolving || albumQuery.isLoading || tracksQuery.isLoading;

  const albumCoverImage = album
    ? pickCatalogImageUrl(undefined, album.coverArt, 'detailArtwork', album.coverArtSizes)
    : undefined;

  // VIEW MODE: theme the WHOLE app from the album's server-extracted cover colours
  // ON VIEW and restore the default on leave. All theming lives in Bloom — this
  // thin effect only feeds the cover colours to Bloom's ambient store (consumed
  // internally by the root provider). Runs before the early returns so the hook
  // order is stable; it no-ops until the album (and its colours) load.
  const { setAmbient, clearAmbient } = useAmbientTheme();
  const albumPrimaryColor = album?.primaryColor;
  const albumSecondaryColor = album?.secondaryColor;
  useEffect(() => {
    if (albumPrimaryColor) {
      setAmbient(albumPrimaryColor, { secondary: albumSecondaryColor });
    }
    return () => clearAmbient();
  }, [albumPrimaryColor, albumSecondaryColor, setAmbient, clearAmbient]);

  const formatReleaseDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  const handlePlayAlbum = () => {
    if (!canPlay) {
      toast.info('No playable tracks available');
      return;
    }

    playTrackList(tracks, 0, {
      type: 'album',
      id,
      name: album?.title,
    });
  };

  const handleTrackPress = (track: Track) => {
    const startIndex = tracks.findIndex((item) => item.id === track.id);
    playTrackList(tracks, startIndex >= 0 ? startIndex : 0, {
      type: 'album',
      id,
      name: album?.title,
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
      <ScrollView
        style={[styles.scrollView, { backgroundColor: theme.colors.backgroundSecondary }]}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <MediaHeaderSkeleton />
      </ScrollView>
    );
  }

  // A failed request is not a missing album: only a 404 falls through to the
  // "not found" branch below, everything else is a load failure with a retry.
  if ((albumQuery.isError || tracksQuery.isError) && !isNotFoundError(albumQuery.error)) {
    return (
      <EmptyState
        containerStyle={{ backgroundColor: theme.colors.backgroundSecondary }}
        icon={{ name: 'cloud-offline-outline' }}
        error={{
          title: 'Could not load this album',
          message: 'Something went wrong while loading this album. Please try again.',
          onRetry: async () => {
            await Promise.all([albumQuery.refetch(), tracksQuery.refetch()]);
          },
        }}
      />
    );
  }

  if (!album) {
    return (
      <EmptyState
        containerStyle={{ backgroundColor: theme.colors.backgroundSecondary }}
        icon={{ name: 'disc-outline' }}
        title="Album not found"
        subtitle="This album may have been removed or is no longer available."
      />
    );
  }

  // The whole app is themed from this album's cover ON VIEW (see the ambient
  // effect above) — the hero + tracklist read the app theme via `useTheme()`. No
  // per-screen theme wrapper and no cover-hover theming on detail pages.
  return (
    <AlbumView
      album={album}
      tracks={tracks}
      albumCoverImage={albumCoverImage}
      currentTrack={currentTrack}
      isPlaying={isPlaying}
      isSaved={isSaved}
      isDownloaded={isDownloaded}
      setIsDownloaded={setIsDownloaded}
      canPlay={canPlay}
      shuffle={shuffle}
      toggleShuffle={toggleShuffle}
      isTrackLiked={isTrackLiked}
      onPlayAlbum={handlePlayAlbum}
      onToggleSave={handleToggleSave}
      onToggleTrackLike={handleToggleTrackLike}
      onTrackPress={handleTrackPress}
      onGoToArtist={() => router.push(`/p/${album.artistId}`)}
      formatReleaseDate={formatReleaseDate}
    />
  );
};

interface AlbumViewProps {
  album: NonNullable<Awaited<ReturnType<typeof musicService.getAlbumById>>>;
  tracks: Track[];
  albumCoverImage: string | undefined;
  currentTrack: Track | null;
  isPlaying: boolean;
  isSaved: boolean;
  isDownloaded: boolean;
  setIsDownloaded: (next: boolean) => void;
  canPlay: boolean;
  shuffle: 'on' | 'off';
  toggleShuffle: () => void;
  isTrackLiked: (id: string) => boolean;
  onPlayAlbum: () => void;
  onToggleSave: () => void;
  onToggleTrackLike: (track: Track, liked: boolean) => void;
  onTrackPress: (track: Track) => void;
  onGoToArtist: () => void;
  formatReleaseDate: (dateString: string) => string;
}

/**
 * The album's presentational view. Reads the app theme via `useTheme()`; the app
 * is already themed from the album cover on view (see the ambient effect in
 * `AlbumScreen`), so the hero + tracklist reflect the artwork palette without any
 * cover-hover handling here.
 */
const AlbumView: React.FC<AlbumViewProps> = ({
  album,
  tracks,
  albumCoverImage,
  currentTrack,
  isPlaying,
  isSaved,
  isDownloaded,
  setIsDownloaded,
  canPlay,
  shuffle,
  toggleShuffle,
  isTrackLiked,
  onPlayAlbum,
  onToggleSave,
  onToggleTrackLike,
  onTrackPress,
  onGoToArtist,
  formatReleaseDate,
}) => {
  const theme = useTheme();
  const [addingAlbumToPlaylist, setAddingAlbumToPlaylist] = useState(false);
  const [trackActionsFor, setTrackActionsFor] = useState<Track | null>(null);
  const releaseDateFormatted = formatReleaseDate(album.releaseDate);
  const totalDurationFormatted = formatTotalDuration(album.totalDuration);
  const albumThumbImage = pickCatalogImageUrl(undefined, album.coverArt, 'icon', album.coverArtSizes);
  const gradientColors: readonly [string, string, string] = [
    album.primaryColor ?? theme.colors.backgroundSecondary,
    album.secondaryColor ?? theme.colors.backgroundSecondary,
    theme.colors.backgroundSecondary,
  ];

  return (
    <>
      <SEO
        title={`${album.title} by ${album.artistName} - Syra`}
        description={`Listen to ${album.title} by ${album.artistName}`}
      />
      <ScrollView
        style={[styles.scrollView, { backgroundColor: theme.colors.backgroundSecondary }]}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <LinearGradient colors={gradientColors} locations={[0, 0.45, 1]} style={styles.heroSection}>
          {/* Header Section */}
          <View style={styles.header}>
            {/* Album Cover (the app is themed from it on view, not on hover) */}
            <View
              style={styles.coverContainer}
              accessibilityRole="image"
              accessibilityLabel={`${album.title} cover art`}
            >
              {albumCoverImage ? (
                <Image
                  source={{ uri: albumCoverImage }}
                  style={styles.coverImage}
                  resizeMode="cover"
                />
              ) : (
                <View style={[styles.coverPlaceholder, { backgroundColor: theme.colors.backgroundSecondary }]}>
                  <Ionicons name="musical-notes" size={64} color={theme.colors.textSecondary} />
                </View>
              )}
            </View>

            {/* Album Info */}
            <View style={styles.infoContainer}>
              <Text style={[styles.albumTitle, { color: theme.colors.text }]} numberOfLines={1}>
                {album.title}
              </Text>

              {/* Artist Info */}
              <Pressable
                style={styles.artistRow}
                onPress={onGoToArtist}
              >
                <Avatar
                  source={albumThumbImage}
                  size={24}
                  style={styles.artistAvatar}
                />
                <Text style={[styles.artistName, { color: theme.colors.text }]}>
                  {album.artistName}
                </Text>
              </Pressable>

              {/* Metadata */}
              <Text style={[styles.metadata, { color: theme.colors.textSecondary }]}>
                {new Date(album.releaseDate).getFullYear()} • {album.totalTracks} songs, {totalDurationFormatted}
              </Text>
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
              onPress={onPlayAlbum}
              disabled={!canPlay}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canPlay }}
            >
              <Ionicons name="play" size={28} color={theme.colors.primaryForeground} />
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
                size={20}
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
                name={isSaved ? "checkmark-circle" : "checkmark-circle-outline"}
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
              onPress={() => setAddingAlbumToPlaylist(true)}
              accessibilityRole="button"
              accessibilityLabel="More options for this album"
            >
              <Ionicons name="ellipsis-horizontal" size={24} color={theme.colors.text} />
            </Pressable>

            <View style={styles.listViewContainer}>
              <Text style={[styles.listViewText, { color: theme.colors.text }]}>List</Text>
              <Ionicons name="list" size={20} color={theme.colors.text} />
            </View>
          </View>
        </LinearGradient>

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
                No playable tracks available
              </Text>
            </View>
          ) : tracks.map((track, index) => {
            const isCurrentTrack = currentTrack?.id === track.id;
            const isTrackPlaying = isCurrentTrack && isPlaying;
            const isLiked = isTrackLiked(track.id);

            return (
              <Pressable
                key={track.id}
                style={[
                  styles.trackRow,
                  isCurrentTrack && { backgroundColor: theme.colors.backgroundSecondary + '40' },
                ]}
                onPress={() => onTrackPress(track)}
              >
                <View style={styles.trackRowLeft}>
                  <View style={styles.trackNumberContainer}>
                    {isTrackPlaying ? (
                      <Ionicons name="volume-high" size={16} color={theme.colors.primary} />
                    ) : (
                      <Text
                        style={[
                          styles.trackNumber,
                          { color: isCurrentTrack ? theme.colors.primary : theme.colors.textSecondary }
                        ]}
                      >
                        {track.trackNumber || index + 1}
                      </Text>
                    )}
                  </View>
                  <View style={styles.trackInfo}>
                    <Text
                      style={[
                        styles.trackTitle,
                        { color: isCurrentTrack ? theme.colors.primary : theme.colors.text }
                      ]}
                      numberOfLines={1}
                    >
                      {track.title}
                    </Text>
                    <View style={styles.trackArtistRow}>
                      {track.isExplicit && (
                        <View style={[styles.explicitBadge, { backgroundColor: theme.colors.backgroundTertiary }]}>
                          <Text style={[styles.explicitText, { color: theme.colors.textSecondary }]}>E</Text>
                        </View>
                      )}
                      <Text
                        style={[styles.trackArtist, { color: theme.colors.textSecondary }]}
                        numberOfLines={1}
                      >
                        {track.artistName}
                      </Text>
                    </View>
                  </View>
                </View>
                <View style={styles.trackRowRight}>
                  {isDownloaded && (
                    <Ionicons name="checkmark-circle" size={16} color={theme.colors.primary} style={styles.trackIcon} />
                  )}
                  <Pressable
                    onPress={(e) => {
                      e?.stopPropagation?.();
                      onToggleTrackLike(track, isLiked);
                    }}
                    style={styles.trackLikeButton}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isLiked }}
                    accessibilityLabel={isLiked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
                  >
                    <Ionicons
                      name={isLiked ? 'heart' : 'heart-outline'}
                      size={18}
                      color={isLiked ? theme.colors.primary : theme.colors.textSecondary}
                    />
                  </Pressable>
                  <Text style={[styles.trackDuration, { color: theme.colors.textSecondary }]}>
                    {formatDuration(track.duration)}
                  </Text>
                  <Pressable
                    onPress={(e) => {
                      e?.stopPropagation?.();
                      setTrackActionsFor(track);
                    }}
                    style={styles.trackLikeButton}
                    accessibilityRole="button"
                    accessibilityLabel={`More options for ${track.title}`}
                  >
                    <Ionicons
                      name="ellipsis-horizontal"
                      size={18}
                      color={theme.colors.textSecondary}
                    />
                  </Pressable>
                </View>
              </Pressable>
            );
          })}
        </View>

        {/* Release Date & Copyright */}
        {album.releaseDate && (
          <View style={styles.footer}>
            <Text style={[styles.footerText, { color: theme.colors.textSecondary }]}>
              {releaseDateFormatted}
            </Text>
            {album.copyright && (
              <Text style={[styles.footerText, { color: theme.colors.textSecondary }]}>
                {album.copyright}
              </Text>
            )}
          </View>
        )}
      </ScrollView>

      <AddToPlaylistSheet
        visible={addingAlbumToPlaylist}
        onClose={() => setAddingAlbumToPlaylist(false)}
        tracks={tracks}
      />

      {trackActionsFor && (
        <TrackActionsSheet
          visible
          onClose={() => setTrackActionsFor(null)}
          track={trackActionsFor}
        />
      )}
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
  heroSection: {
    paddingTop: 0,
  },
  header: {
    flexDirection: 'row',
    padding: 24,
    paddingBottom: 16,
    gap: 20,
  },
  coverContainer: {
    width: 160,
    height: 160,
    ...Platform.select({
      web: {
        maxWidth: 160,
        maxHeight: 160,
      },
    }),
  },
  coverImage: {
    width: '100%',
    height: '100%',
    borderRadius: 8,
  },
  coverPlaceholder: {
    width: '100%',
    height: '100%',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  infoContainer: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingBottom: 8,
  },
  albumTitle: {
    fontSize: 42,
    fontWeight: 'bold',
    marginBottom: 8,
    letterSpacing: -0.5,
  },
  artistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  artistAvatar: {
    marginRight: 0,
  },
  artistName: {
    fontSize: 16,
    fontWeight: '600',
  },
  metadata: {
    fontSize: 14,
  },
  controlsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 12,
    gap: 12,
  },
  playButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  disabledControl: {
    opacity: 0.5,
  },
  controlButton: {
    padding: 8,
    borderRadius: 20,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  listViewContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'auto',
  },
  listViewText: {
    fontSize: 14,
    fontWeight: '600',
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
    alignItems: 'center',
    paddingVertical: 48,
  },
  emptyStateText: {
    fontSize: 15,
  },
  trackRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 4,
    minHeight: 40,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  trackRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    flex: 1,
    minWidth: 0,
  },
  trackNumberContainer: {
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackNumber: {
    fontSize: 14,
    textAlign: 'center',
  },
  trackInfo: {
    flex: 1,
    minWidth: 0,
  },
  trackTitle: {
    fontSize: 15,
    fontWeight: '400',
    marginBottom: 3,
  },
  trackArtistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  explicitBadge: {
    width: 18,
    height: 18,
    borderRadius: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  explicitText: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  trackArtist: {
    fontSize: 14,
  },
  trackRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  trackIcon: {
    marginRight: 0,
  },
  trackLikeButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  trackDuration: {
    fontSize: 14,
    width: 40,
    textAlign: 'right',
  },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 16,
  },
  footerText: {
    fontSize: 12,
    marginBottom: 4,
  },
});

export default AlbumScreen;
