import React, { useState } from 'react';
import { StyleSheet, View, ScrollView, Text, Pressable, Image, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@oxyhq/bloom/theme';
import { musicService } from '@/services/musicService';
import { Track } from '@syra/shared-types';
import { Ionicons } from '@expo/vector-icons';
import { usePlayerStore } from '@/stores/playerStore';
import { useQueueStore } from '@/stores/queueStore';
import SEO from '@/components/SEO';
import Avatar from '@/components/Avatar';
import { MediaHeaderSkeleton } from '@/components/skeletons';
import { formatDuration, formatTotalDuration } from '@/utils/musicUtils';
import { useLibrary, useToggleSaveAlbum, useToggleLikeTrack } from '@/hooks/useLibrary';
import { LinearGradient } from 'expo-linear-gradient';
import { pickCatalogImageUrl } from '@/utils/pickImage';

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

  const handleToggleTrackLike = (trackId: string, liked: boolean) => {
    toggleLike.mutate({ id: trackId, next: !liked });
  };

  const { data, isLoading } = useQuery({
    queryKey: ['album', id],
    queryFn: async () => {
      const [albumData, tracksData] = await Promise.all([
        musicService.getAlbumById(id),
        musicService.getAlbumTracks(id),
      ]);
      return {
        album: albumData,
        tracks: tracksData.tracks.sort((a, b) => (a.trackNumber || 0) - (b.trackNumber || 0)),
      };
    },
    enabled: !!id,
  });

  const album = data?.album ?? null;
  const tracks = data?.tracks ?? [];


  const formatReleaseDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  const handlePlayAlbum = () => {
    if (tracks.length > 0) {
      playTrackList(tracks, 0, {
        type: 'album',
        id,
        name: album?.title,
      });
    }
  };

  const handleTrackPress = (track: Track) => {
    const startIndex = tracks.findIndex((item) => item.id === track.id);
    playTrackList(tracks, startIndex >= 0 ? startIndex : 0, {
      type: 'album',
      id,
      name: album?.title,
    });
  };

  if (isLoading) {
    return (
      <ScrollView
        style={[styles.scrollView, { backgroundColor: theme.colors.background }]}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <MediaHeaderSkeleton />
      </ScrollView>
    );
  }

  if (!album) {
    return (
      <View style={[styles.errorContainer, { backgroundColor: theme.colors.background }]}>
        <Text style={[styles.errorText, { color: theme.colors.text }]}>Album not found</Text>
      </View>
    );
  }

  const releaseDateFormatted = formatReleaseDate(album.releaseDate);
  const totalDurationFormatted = formatTotalDuration(album.totalDuration);
  const albumCoverImage = pickCatalogImageUrl(undefined, album.coverArt, 'detailArtwork', album.coverArtSizes);
  const albumThumbImage = pickCatalogImageUrl(undefined, album.coverArt, 'icon', album.coverArtSizes);
  const gradientColors: readonly [string, string, string] = [
    album.primaryColor ?? theme.colors.backgroundSecondary,
    album.secondaryColor ?? theme.colors.background,
    theme.colors.background,
  ];

  return (
    <>
      <SEO
        title={`${album.title} by ${album.artistName} - Syra`}
        description={`Listen to ${album.title} by ${album.artistName}`}
      />
      <ScrollView
        style={[styles.scrollView, { backgroundColor: theme.colors.background }]}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <LinearGradient colors={gradientColors} locations={[0, 0.45, 1]} style={styles.heroSection}>
          {/* Header Section */}
          <View style={styles.header}>
            {/* Album Cover */}
            <View style={styles.coverContainer}>
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
                onPress={() => router.push(`/artist/${album.artistId}`)}
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
              style={[styles.playButton, { backgroundColor: theme.colors.primary }]}
              onPress={handlePlayAlbum}
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
              onPress={handleToggleSave}
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

            <Pressable style={styles.controlButton}>
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
          {tracks.map((track, index) => {
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
                onPress={() => handleTrackPress(track)}
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
                      handleToggleTrackLike(track.id, isLiked);
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
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorText: {
    fontSize: 16,
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
