import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, ScrollView, Text, Platform, Pressable } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '@oxyhq/bloom/theme';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { RoomCard, useLiveRoom, createAgoraService, type Room } from '@syra.fm/live';
import SEO from '@/components/SEO';
import { MediaCard } from '@/components/MediaCard';
import { ResponsiveGrid } from '@/components/ResponsiveGrid';
import { QuickAccessGridSkeleton, MediaCardRowSkeleton } from '@/components/skeletons';
import { musicService } from '@/services/musicService';
import { Track, Album, Artist, Playlist } from '@syra/shared-types';
import { usePlayerStore } from '@/stores/playerStore';
import { useQueueStore } from '@/stores/queueStore';
import { useUIStore } from '@/stores/uiStore';
import {
  useRecentlyPlayed,
  useMadeForYou,
  usePopularAlbums,
  usePopularArtists,
  useUserPlaylists,
  usePopularTracks,
} from '@/hooks/useHomeFeed';
import { usePodcasts } from '@/hooks/usePodcasts';
import { createScopedLogger } from '@/utils/logger';
import { Ionicons } from '@expo/vector-icons';
import { pickCatalogImageUrl } from '@/utils/pickImage';
import { resolvePodcastImageUri } from '@/utils/podcastImages';
import { authenticatedClient } from '@/utils/api';
import { liveRoomsQueryKey } from '@/lib/liveConfig';
import { toast } from '@/lib/sonner';

const logger = createScopedLogger('HomeScreen');

/**
 * Parse a hex color string into RGB components. Pure helper hoisted to module
 * scope so it can be referenced from effects without a use-before-declaration.
 */
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

/**
 * Quick access item type - can be album, artist, or playlist
 */
type QuickAccessItem =
  | { type: 'album'; data: Album; shape: 'square' }
  | { type: 'artist'; data: Artist; shape: 'circle' }
  | { type: 'playlist'; data: Playlist; shape: 'square' };

/**
 * Syra Home Screen
 *
 * Spotify-like home built from 100% REAL backend data via React Query — no
 * sliced/relabeled sections. Each section reads its own query hook
 * ({@link file://./../hooks/useHomeFeed.ts}); there is no `useEffect`/`useState`
 * data fetching. Sections with no real data are hidden rather than faked.
 */
const HomeScreen: React.FC = () => {
  const theme = useTheme();
  const router = useRouter();
  const { t } = useTranslation();
  const { joinLiveRoom } = useLiveRoom();
  const [now, setNow] = useState(() => new Date());
  const { playTrackList } = usePlayerStore();
  const { addTracksLocally } = useQueueStore();
  const setShellGradientColor = useUIStore(s => s.setShellGradientColor);

  // Real, per-section queries — each loads/caches/errors independently.
  const recentlyPlayedQuery = useRecentlyPlayed();
  const madeForYouQuery = useMadeForYou();
  const popularAlbumsQuery = usePopularAlbums();
  const popularArtistsQuery = usePopularArtists();
  const userPlaylistsQuery = useUserPlaylists();
  const tracksQuery = usePopularTracks();

  // Live rooms — the same fetch the Live surface uses (public, error-swallowing:
  // `getRooms` returns `[]` on failure/no-auth). Keyed off the shared
  // `liveRoomsQueryKey` so it shares one cache authority with `app/live.tsx`.
  const agoraService = useMemo(() => createAgoraService(authenticatedClient), []);
  const liveRoomsQuery = useQuery({
    queryKey: liveRoomsQueryKey,
    queryFn: () => agoraService.getRooms('live'),
    staleTime: 30_000,
  });

  // Podcasts — popular shows from the public catalog (same hook the podcasts
  // browse screen uses); runs for guests too.
  const podcastsQuery = usePodcasts({ sort: 'popular', limit: 12 });

  // Derive section data from the queries (empty arrays while pending).
  const recentlyPlayed = useMemo<Track[]>(
    () => recentlyPlayedQuery.data?.tracks ?? [],
    [recentlyPlayedQuery.data],
  );
  const madeForYouAlbums = useMemo<Album[]>(
    () => madeForYouQuery.data?.albums ?? [],
    [madeForYouQuery.data],
  );
  const madeForYouPlaylists = useMemo<Playlist[]>(
    () => madeForYouQuery.data?.playlists ?? [],
    [madeForYouQuery.data],
  );
  const madeForYouArtists = useMemo<Artist[]>(
    () => madeForYouQuery.data?.artists ?? [],
    [madeForYouQuery.data],
  );
  const isPersonalized = useMemo<boolean>(
    () => madeForYouQuery.data?.personalized === true,
    [madeForYouQuery.data],
  );
  const popularAlbums = useMemo<Album[]>(
    () => popularAlbumsQuery.data?.albums ?? [],
    [popularAlbumsQuery.data],
  );
  const popularArtists = useMemo<Artist[]>(
    () => popularArtistsQuery.data?.artists ?? [],
    [popularArtistsQuery.data],
  );
  const userPlaylists = useMemo<Playlist[]>(
    () => userPlaylistsQuery.data?.playlists ?? [],
    [userPlaylistsQuery.data],
  );
  const tracks = useMemo<Track[]>(
    () => tracksQuery.data?.tracks ?? [],
    [tracksQuery.data],
  );
  const liveRooms = useMemo<Room[]>(
    () => liveRoomsQuery.data ?? [],
    [liveRoomsQuery.data],
  );
  const podcasts = useMemo(
    () => podcastsQuery.data ?? [],
    [podcastsQuery.data],
  );

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => () => {
    setShellGradientColor(null);
  }, [setShellGradientColor]);

  // Cross-fade gradient layers so hover color changes do not snap.
  const [hoveredItemColor, setHoveredItemColor] = useState<string | null>(null);
  const [gradientOpacity] = useState(() => new Animated.Value(1));
  const displayedGradientColorRef = useRef(theme.colors.primary);
  const targetGradientColorRef = useRef(theme.colors.primary);
  const [gradientFromColor, setGradientFromColor] = useState(theme.colors.primary);
  const [gradientToColor, setGradientToColor] = useState(theme.colors.primary);

  // Get greeting based on time
  const greeting = useMemo(() => {
    const hour = now.getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }, [now]);

  // Convert hex to rgba string for LinearGradient
  const hexToRgba = useCallback((hex: string, alpha: number = 0.2): string => {
    const rgb = hexToRgb(hex);
    if (!rgb) return `rgba(128, 128, 128, ${alpha})`; // Fallback gray
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }, []);

  const getGradientColors = useCallback((color: string): [string, string, string] => ([
    hexToRgba(color, 0.46),
    hexToRgba(color, 0.22),
    theme.colors.backgroundSecondary,
  ]), [hexToRgba, theme.colors.backgroundSecondary]);

  useEffect(() => {
    const nextColor = hoveredItemColor || theme.colors.primary;
    if (targetGradientColorRef.current === nextColor) {
      return;
    }

    setGradientFromColor(targetGradientColorRef.current);
    setGradientToColor(nextColor);
    targetGradientColorRef.current = nextColor;
    gradientOpacity.setValue(0);

    const animation = Animated.timing(gradientOpacity, {
      toValue: 1,
      duration: 520,
      easing: Easing.bezier(0.16, 1, 0.3, 1),
      useNativeDriver: Platform.OS !== 'web',
    });

    animation.start(({ finished }) => {
      if (finished) {
        displayedGradientColorRef.current = nextColor;
        setGradientFromColor(nextColor);
      }
    });

    return () => {
      animation.stop();
    };
  }, [gradientOpacity, hoveredItemColor, theme.colors.primary]);

  // Handle hover in - set the color
  const handleHoverIn = useCallback((color: string | null | undefined) => {
    const nextColor = color || theme.colors.primary;
    setHoveredItemColor(nextColor);
    setShellGradientColor(nextColor);
  }, [setShellGradientColor, theme.colors.primary]);

  // Handle hover out - reset to default
  const handleHoverOut = useCallback(() => {
    setHoveredItemColor(null);
    setShellGradientColor(null);
  }, [setShellGradientColor]);

  // Navigate to and start playing an album's first track. Used by album cards'
  // play button so a single tap actually plays real audio.
  const playAlbum = useCallback(async (albumId: string, albumName?: string) => {
    try {
      const { tracks: albumTracks } = await musicService.getAlbumTracks(albumId);
      if (albumTracks.length > 0) {
        await playTrackList(albumTracks, 0, {
          type: 'album',
          id: albumId,
          name: albumName,
        });
        return;
      }
      toast.info('No playable tracks available');
    } catch (error) {
      logger.error('Error playing album', { albumId, error });
      toast.error('Could not start playback');
    }
  }, [playTrackList]);

  const playPlaylist = useCallback(async (playlistId: string, playlistName?: string) => {
    try {
      const { tracks: playlistTracks } = await musicService.getPlaylistTracks(playlistId);
      if (playlistTracks.length > 0) {
        await playTrackList(playlistTracks, 0, {
          type: 'playlist',
          id: playlistId,
          name: playlistName,
        });
        return;
      }
      toast.info('No playable tracks available');
    } catch (error) {
      logger.error('Error playing playlist', { playlistId, error });
      toast.error('Could not start playback');
    }
  }, [playTrackList]);

  const playArtist = useCallback(async (artistId: string, artistName?: string) => {
    try {
      const { tracks: artistTracks } = await musicService.getArtistTracks(artistId, { limit: 50 });
      if (artistTracks.length > 0) {
        await playTrackList(artistTracks, 0, {
          type: 'artist',
          id: artistId,
          name: artistName,
        });
        return;
      }
      toast.info('No playable tracks available');
    } catch (error) {
      logger.error('Error playing artist', { artistId, error });
      toast.error('Could not start playback');
    }
  }, [playTrackList]);

  const addTrackToQueue = useCallback((track: Track) => {
    addTracksLocally([track], 'last');
    toast.success('Added to queue');
  }, [addTracksLocally]);

  const addAlbumToQueue = useCallback(async (albumId: string) => {
    try {
      const { tracks: albumTracks } = await musicService.getAlbumTracks(albumId);
      if (albumTracks.length === 0) {
        toast.info('No tracks to add');
        return;
      }
      addTracksLocally(albumTracks, 'last');
      toast.success('Added to queue');
    } catch (error) {
      logger.error('Error adding album to queue', { albumId, error });
      toast.error('Could not add to queue');
    }
  }, [addTracksLocally]);

  const addPlaylistToQueue = useCallback(async (playlistId: string) => {
    try {
      const { tracks: playlistTracks } = await musicService.getPlaylistTracks(playlistId);
      if (playlistTracks.length === 0) {
        toast.info('No tracks to add');
        return;
      }
      addTracksLocally(playlistTracks, 'last');
      toast.success('Added to queue');
    } catch (error) {
      logger.error('Error adding playlist to queue', { playlistId, error });
      toast.error('Could not add to queue');
    }
  }, [addTracksLocally]);

  const addArtistToQueue = useCallback(async (artistId: string) => {
    try {
      const { tracks: artistTracks } = await musicService.getArtistTracks(artistId, { limit: 50 });
      if (artistTracks.length === 0) {
        toast.info('No tracks to add');
        return;
      }
      addTracksLocally(artistTracks, 'last');
      toast.success('Added to queue');
    } catch (error) {
      logger.error('Error adding artist to queue', { artistId, error });
      toast.error('Could not add to queue');
    }
  }, [addTracksLocally]);

  // Compute quick access items from real data (mix of albums, artists, playlists)
  const quickAccess = useMemo<QuickAccessItem[]>(() => {
    const items: QuickAccessItem[] = [];

    // Add popular albums (up to 4)
    popularAlbums.slice(0, 4).forEach(album => {
      items.push({ type: 'album', data: album, shape: 'square' });
    });

    // Add popular artists (up to 2)
    popularArtists.slice(0, 2).forEach(artist => {
      items.push({ type: 'artist', data: artist, shape: 'circle' });
    });

    // Fill remaining slots with the user's own playlists
    const remainingSlots = 8 - items.length;
    userPlaylists.slice(0, remainingSlots).forEach(playlist => {
      items.push({ type: 'playlist', data: playlist, shape: 'square' });
    });

    return items.slice(0, 8);
  }, [popularAlbums, popularArtists, userPlaylists]);

  // Loading gates derived from the queries (skeleton while first load pending).
  const quickAccessLoading =
    popularAlbumsQuery.isPending || popularArtistsQuery.isPending;
  const hasQuickAccess = quickAccess.length > 0;
  const hasMadeForYou =
    madeForYouAlbums.length > 0 ||
    madeForYouPlaylists.length > 0 ||
    madeForYouArtists.length > 0;

  return (
    <>
      <SEO
        title="Syra - Music Streaming"
        description="Discover and play your favorite music"
      />
      <View style={[styles.gradientContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <LinearGradient
          colors={getGradientColors(gradientFromColor)}
          locations={[0, 0.48, 1]}
          pointerEvents="none"
          style={styles.fixedGradient}
        />
        <Animated.View
          pointerEvents="none"
          style={[styles.fixedGradient, { opacity: gradientOpacity }]}
        >
          <LinearGradient
            colors={getGradientColors(gradientToColor)}
            locations={[0, 0.48, 1]}
            pointerEvents="none"
            style={styles.gradientFill}
          />
        </Animated.View>
        <ScrollView
          style={[styles.scrollView, { backgroundColor: 'transparent' }]}
          contentContainerStyle={[
            styles.contentContainer,
            { paddingBottom: 100 } // Space for bottom player bar
          ]}
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.colors.text }]}>
              {greeting}
            </Text>
          </View>

          {/* Live now — currently-live audio rooms, surfaced at the top because
              live content is time-sensitive. Reuses the Live surface's exact
              fetch + RoomCard; hidden entirely when nothing is live (the home
              hides empty sections rather than faking them). */}
          {liveRooms.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <View style={styles.liveHeading}>
                  <View style={[styles.liveDot, { backgroundColor: theme.colors.error }]} />
                  <Text style={[styles.sectionHeaderTitle, { color: theme.colors.text }]}>
                    {t('Live now')}
                  </Text>
                </View>
                <Pressable style={styles.seeAllButton} onPress={() => router.push('/live')} hitSlop={8}>
                  <Text style={[styles.seeAll, { color: theme.colors.textSecondary }]}>
                    {t('See all')}
                  </Text>
                </Pressable>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.rail}
              >
                {liveRooms.map((room) => (
                  <RoomCard
                    key={room._id}
                    room={room}
                    variant="compact"
                    onPress={() => joinLiveRoom(room._id)}
                  />
                ))}
              </ScrollView>
            </View>
          )}

          {/* 8-Item Compact Grid (2 columns) - real albums/artists/playlists */}
          {quickAccessLoading ? (
            <QuickAccessGridSkeleton />
          ) : hasQuickAccess && (
            <ResponsiveGrid minItemWidth={300} minColumns={2} gap={8} style={styles.compactGrid}>
              {quickAccess.map((item) => {
                const title = item.type === 'album' ? item.data.title : item.data.name;
                const id = item.data.id;
                const itemKey = `${item.type}-${id}`;
                const primaryColor = item.data.primaryColor;
                const imageUri = item.type === 'artist'
                  ? pickCatalogImageUrl(item.data.images, item.data.image, 'icon', item.data.imageSizes)
                  : pickCatalogImageUrl(undefined, item.data.coverArt, 'icon', item.data.coverArtSizes);

                return (
                  <Pressable
                    key={itemKey}
                    style={[styles.compactGridItem, { backgroundColor: theme.colors.backgroundSecondary }]}
                    onPress={() => {
                      if (item.type === 'album') {
                        router.push(`/album/${id}`);
                      } else if (item.type === 'playlist') {
                        router.push(`/playlist/${id}`);
                      } else {
                        router.push(`/p/${id}`);
                      }
                    }}
                    onHoverIn={() => handleHoverIn(primaryColor)}
                    onHoverOut={handleHoverOut}
                  >
                    <View
                      style={[
                        styles.compactImageContainer,
                        {
                          backgroundColor: theme.colors.background,
                          borderRadius: item.shape === 'circle' ? 999 : 12,
                        }
                      ]}
                    >
                      {imageUri ? (
                        <Image
                          source={{ uri: imageUri }}
                          style={[
                            styles.compactImage,
                            { borderRadius: item.shape === 'circle' ? 999 : 12 },
                          ]}
                          contentFit="cover"
                        />
                      ) : (
                        <Ionicons
                          name={item.type === 'artist' ? 'person' : 'musical-notes'}
                          size={24}
                          color={theme.colors.textSecondary}
                        />
                      )}
                    </View>
                    <Text
                      style={[styles.compactTitle, { color: theme.colors.text }]}
                      numberOfLines={1}
                    >
                      {title}
                    </Text>
                  </Pressable>
                );
              })}
            </ResponsiveGrid>
          )}

          {/* Jump back in — REAL recently-played tracks (authed). Hidden when
              the user has no play history yet (no faking). */}
          {recentlyPlayedQuery.isPending ? (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Jump back in
              </Text>
              <MediaCardRowSkeleton count={5} />
            </View>
          ) : recentlyPlayed.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Jump back in
              </Text>
              <ResponsiveGrid minItemWidth={180} gap={8}>
                {recentlyPlayed.map((track) => (
                  <View key={track.id}>
                    <MediaCard
                      title={track.title}
                      subtitle={track.artistName}
                      type="track"
                      imageUri={track.coverArt}
                      images={track.images}
                      imageSizes={track.coverArtSizes}
                      primaryColor={track.primaryColor}
                      onPress={() => {
                        if (track.albumId) {
                          router.push(`/album/${track.albumId}`);
                        } else {
                          router.push(`/p/${track.artistId}`);
                        }
                      }}
                      onPlayPress={() => playTrackList(
                        recentlyPlayed,
                        recentlyPlayed.findIndex((item) => item.id === track.id),
                        {
                          type: 'library',
                          name: 'Recently played',
                        },
                      )}
                      onAddToQueue={() => addTrackToQueue(track)}
                      onGoToAlbum={track.albumId ? () => router.push(`/album/${track.albumId}`) : undefined}
                      onGoToArtist={() => router.push(`/p/${track.artistId}`)}
                      onHoverIn={() => handleHoverIn(track.primaryColor)}
                      onHoverOut={handleHoverOut}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </View>
          )}

          {/* Made for You — REAL recommendations (popular albums + public playlists) */}
          {madeForYouQuery.isPending ? (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Made for you
              </Text>
              <MediaCardRowSkeleton count={5} />
            </View>
          ) : hasMadeForYou && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                {isPersonalized ? 'Hecho para ti' : 'Made for you'}
              </Text>
              <ResponsiveGrid minItemWidth={180} gap={8}>
                {madeForYouArtists.map((artist) => (
                  <View key={artist.id}>
                    <MediaCard
                      title={artist.name}
                      subtitle="Artist"
                      type="artist"
                      imageUri={artist.image}
                      images={artist.images}
                      imageSizes={artist.imageSizes}
                      primaryColor={artist.primaryColor}
                      onPress={() => router.push(`/p/${artist.id}`)}
                      onPlayPress={() => playArtist(artist.id, artist.name)}
                      onAddToQueue={() => addArtistToQueue(artist.id)}
                      onHoverIn={() => handleHoverIn(artist.primaryColor)}
                      onHoverOut={handleHoverOut}
                    />
                  </View>
                ))}
                {madeForYouPlaylists.map((playlist) => (
                  <View key={playlist.id}>
                    <MediaCard
                      title={playlist.name}
                      subtitle={playlist.description || 'Playlist'}
                      type="playlist"
                      imageUri={playlist.coverArt}
                      imageSizes={playlist.coverArtSizes}
                      primaryColor={playlist.primaryColor}
                      onPress={() => router.push(`/playlist/${playlist.id}`)}
                      onPlayPress={() => playPlaylist(playlist.id, playlist.name)}
                      onAddToQueue={() => addPlaylistToQueue(playlist.id)}
                      onHoverIn={() => handleHoverIn(playlist.primaryColor)}
                      onHoverOut={handleHoverOut}
                    />
                  </View>
                ))}
                {madeForYouAlbums.map((album) => (
                  <View key={album.id}>
                    <MediaCard
                      title={album.title}
                      subtitle={album.artistName}
                      type="album"
                      imageUri={album.coverArt}
                      imageSizes={album.coverArtSizes}
                      primaryColor={album.primaryColor}
                      onPress={() => router.push(`/album/${album.id}`)}
                      onPlayPress={() => playAlbum(album.id, album.title)}
                      onAddToQueue={() => addAlbumToQueue(album.id)}
                      onGoToArtist={() => router.push(`/p/${album.artistId}`)}
                      onHoverIn={() => handleHoverIn(album.primaryColor)}
                      onHoverOut={handleHoverOut}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </View>
          )}

          {/* Podcasts — popular shows from the public catalog. Mirrors the music
              rails (same MediaCard + ResponsiveGrid); "See all" opens the
              podcasts browse screen. Hidden when the catalog has no shows. */}
          {podcastsQuery.isPending ? (
            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <Text style={[styles.sectionHeaderTitle, { color: theme.colors.text }]}>
                  {t('Podcasts')}
                </Text>
              </View>
              <MediaCardRowSkeleton count={5} />
            </View>
          ) : podcasts.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <Text style={[styles.sectionHeaderTitle, { color: theme.colors.text }]}>
                  {t('Podcasts')}
                </Text>
                <Pressable style={styles.seeAllButton} onPress={() => router.push('/podcasts')} hitSlop={8}>
                  <Text style={[styles.seeAll, { color: theme.colors.textSecondary }]}>
                    {t('See all')}
                  </Text>
                </Pressable>
              </View>
              <ResponsiveGrid minItemWidth={180} gap={8}>
                {podcasts.map((podcast) => (
                  <View key={podcast.id}>
                    <MediaCard
                      title={podcast.title}
                      subtitle={podcast.author ?? t('Podcast')}
                      type="podcast"
                      resolvedImageUri={resolvePodcastImageUri(podcast, 'card')}
                      primaryColor={podcast.primaryColor}
                      onPress={() => router.push({ pathname: '/podcasts/[id]', params: { id: podcast.id } })}
                      onPlayPress={() => router.push({ pathname: '/podcasts/[id]', params: { id: podcast.id } })}
                      onHoverIn={() => handleHoverIn(podcast.primaryColor)}
                      onHoverOut={handleHoverOut}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </View>
          )}

          {/* Popular albums — REAL, ranked by catalog popularity */}
          {popularAlbumsQuery.isPending ? (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Popular albums
              </Text>
              <MediaCardRowSkeleton count={5} />
            </View>
          ) : popularAlbums.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Popular albums
              </Text>
              <ResponsiveGrid minItemWidth={180} gap={8}>
                {popularAlbums.map((album) => (
                  <View key={album.id}>
                    <MediaCard
                      title={album.title}
                      subtitle={album.artistName}
                      type="album"
                      imageUri={album.coverArt}
                      imageSizes={album.coverArtSizes}
                      primaryColor={album.primaryColor}
                      onPress={() => router.push(`/album/${album.id}`)}
                      onPlayPress={() => playAlbum(album.id, album.title)}
                      onAddToQueue={() => addAlbumToQueue(album.id)}
                      onGoToArtist={() => router.push(`/p/${album.artistId}`)}
                      onHoverIn={() => handleHoverIn(album.primaryColor)}
                      onHoverOut={handleHoverOut}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </View>
          )}

          {/* Popular artists — REAL, ranked by catalog popularity */}
          {popularArtistsQuery.isPending ? null : popularArtists.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Popular artists
              </Text>
              <ResponsiveGrid minItemWidth={180} gap={8}>
                {popularArtists.map((artist) => (
                  <View key={artist.id}>
                    <MediaCard
                      title={artist.name}
                      subtitle="Artist"
                      type="artist"
                      imageUri={artist.image}
                      images={artist.images}
                      imageSizes={artist.imageSizes}
                      primaryColor={artist.primaryColor}
                      onPress={() => router.push(`/p/${artist.id}`)}
                      onPlayPress={() => playArtist(artist.id, artist.name)}
                      onAddToQueue={() => addArtistToQueue(artist.id)}
                      onHoverIn={() => handleHoverIn(artist.primaryColor)}
                      onHoverOut={handleHoverOut}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </View>
          )}

          {/* Your playlists — REAL, the signed-in user's own playlists */}
          {userPlaylistsQuery.isPending ? null : userPlaylists.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Your playlists
              </Text>
              <ResponsiveGrid minItemWidth={180} gap={8}>
                {userPlaylists.map((playlist) => (
                  <View key={playlist.id}>
                    <MediaCard
                      title={playlist.name}
                      subtitle={playlist.description || 'Playlist'}
                      type="playlist"
                      imageUri={playlist.coverArt}
                      imageSizes={playlist.coverArtSizes}
                      primaryColor={playlist.primaryColor}
                      onPress={() => router.push(`/playlist/${playlist.id}`)}
                      onPlayPress={() => playPlaylist(playlist.id, playlist.name)}
                      onAddToQueue={() => addPlaylistToQueue(playlist.id)}
                      onHoverIn={() => handleHoverIn(playlist.primaryColor)}
                      onHoverOut={handleHoverOut}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </View>
          )}

          {/* Popular tracks — REAL, ranked by catalog popularity */}
          {tracksQuery.isPending ? (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Popular tracks
              </Text>
              <MediaCardRowSkeleton count={10} />
            </View>
          ) : tracks.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Popular tracks
              </Text>
              <ResponsiveGrid minItemWidth={180} gap={8}>
                {tracks.map((track) => (
                  <View key={track.id}>
                    <MediaCard
                      title={track.title}
                      subtitle={track.artistName}
                      type="track"
                      imageUri={track.coverArt}
                      images={track.images}
                      imageSizes={track.coverArtSizes}
                      primaryColor={track.primaryColor}
                      onPress={() => {
                        if (track.albumId) {
                          router.push(`/album/${track.albumId}`);
                        } else {
                          router.push(`/p/${track.artistId}`);
                        }
                      }}
                      onPlayPress={() => playTrackList(tracks, tracks.findIndex((item) => item.id === track.id), {
                        type: 'track',
                        name: 'Popular tracks',
                      })}
                      onAddToQueue={() => addTrackToQueue(track)}
                      onGoToAlbum={track.albumId ? () => router.push(`/album/${track.albumId}`) : undefined}
                      onGoToArtist={() => router.push(`/p/${track.artistId}`)}
                      onHoverIn={() => handleHoverIn(track.primaryColor)}
                      onHoverOut={handleHoverOut}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </View>
          )}
        </ScrollView>
      </View>
    </>
  );
};

const styles = StyleSheet.create({
  gradientContainer: {
    flex: 1,
    overflow: 'hidden',
  },
  fixedGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 520,
  },
  gradientFill: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    ...Platform.select({
      web: {
        maxWidth: '100%',
      },
    }),
  },
  header: {
    marginBottom: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
  },
  compactGrid: {
    marginBottom: 24,
  },
  compactGridItem: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: 12,
    alignItems: 'center',
  },
  compactImageContainer: {
    width: 40,
    height: 40,
    marginRight: 6,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  compactImage: {
    width: '100%',
    height: '100%',
  },
  compactTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 16,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sectionHeaderTitle: {
    fontSize: 22,
    fontWeight: 'bold',
  },
  liveHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
  },
  seeAllButton: {
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  seeAll: {
    fontSize: 13,
    fontWeight: '600',
  },
  rail: {
    gap: 12,
    paddingVertical: 2,
  },
});

export default HomeScreen;
