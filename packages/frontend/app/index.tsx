import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { StyleSheet, View, ScrollView, Text, Platform, Pressable } from 'react-native';
import { useTheme, useAmbientTheme } from '@oxyhq/bloom/theme';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { RoomCard, useLiveRoom, createRoomsService, type Room } from '@syra.fm/live';
import SEO from '@/components/SEO';
import { MediaCard } from '@/components/MediaCard';
import { ResponsiveGrid } from '@/components/ResponsiveGrid';
import { QuickAccessGridSkeleton, MediaCardRowSkeleton } from '@/components/skeletons';
import { musicService } from '@/services/musicService';
import { Track, Album, Artist, Playlist, Podcast, PlaybackContext } from '@syra/shared-types';
import { usePlayerStore } from '@/stores/playerStore';
import { useQueueStore } from '@/stores/queueStore';
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
import { authenticatedClient } from '@/utils/api';
import { liveRoomsQueryKey } from '@/lib/liveConfig';
import { toast } from '@/lib/sonner';

const logger = createScopedLogger('HomeScreen');

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
  const { t } = useTranslation();
  const [now, setNow] = useState(() => new Date());
  const { playTrackList } = usePlayerStore();
  const { addTracksLocally } = useQueueStore();
  // HOVER MODE: hovering any card themes the WHOLE app from that card's
  // server-extracted cover colours; leaving restores the default. All theming
  // lives in Bloom — these thin handlers only feed the card's DTO colours to
  // Bloom's ambient store (which the root provider consumes internally).
  const { setAmbient, clearAmbient } = useAmbientTheme();
  const handleHoverIn = useCallback(
    (colors: { primaryColor?: string; secondaryColor?: string }) => {
      if (colors.primaryColor) {
        setAmbient(colors.primaryColor, { secondary: colors.secondaryColor });
      }
    },
    [setAmbient],
  );
  const handleHoverOut = clearAmbient;

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
  const roomsService = useMemo(() => createRoomsService(authenticatedClient), []);
  const liveRoomsQuery = useQuery({
    queryKey: liveRoomsQueryKey,
    queryFn: () => roomsService.getRooms('live'),
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

  // Get greeting based on time
  const greeting = useMemo(() => {
    const hour = now.getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }, [now]);

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
      {/* Hovering any card themes the WHOLE app from that card's artwork; leaving
          restores the default. Theming is owned by Bloom's ambient store (fed via
          `useAmbientTheme`) and applied by the root `BloomThemeProvider` — no
          per-screen theme wrapper. */}
      <HomeContent
          greeting={greeting}
          liveRooms={liveRooms}
          quickAccess={quickAccess}
          quickAccessLoading={quickAccessLoading}
          hasQuickAccess={hasQuickAccess}
          hasMadeForYou={hasMadeForYou}
          recentlyPlayed={recentlyPlayed}
          recentlyPlayedPending={recentlyPlayedQuery.isPending}
          madeForYouArtists={madeForYouArtists}
          madeForYouPlaylists={madeForYouPlaylists}
          madeForYouAlbums={madeForYouAlbums}
          madeForYouPending={madeForYouQuery.isPending}
          isPersonalized={isPersonalized}
          podcasts={podcasts}
          podcastsPending={podcastsQuery.isPending}
          popularAlbums={popularAlbums}
          popularAlbumsPending={popularAlbumsQuery.isPending}
          popularArtists={popularArtists}
          popularArtistsPending={popularArtistsQuery.isPending}
          userPlaylists={userPlaylists}
          userPlaylistsPending={userPlaylistsQuery.isPending}
          tracks={tracks}
          tracksPending={tracksQuery.isPending}
          t={t}
          onSeedHoverIn={handleHoverIn}
          onSeedHoverOut={handleHoverOut}
          playTrackList={playTrackList}
          playAlbum={playAlbum}
          playPlaylist={playPlaylist}
          playArtist={playArtist}
          addTrackToQueue={addTrackToQueue}
          addAlbumToQueue={addAlbumToQueue}
          addPlaylistToQueue={addPlaylistToQueue}
          addArtistToQueue={addArtistToQueue}
        />
    </>
  );
};

interface HomeContentProps {
  greeting: string;
  liveRooms: Room[];
  quickAccess: QuickAccessItem[];
  quickAccessLoading: boolean;
  hasQuickAccess: boolean;
  hasMadeForYou: boolean;
  recentlyPlayed: Track[];
  recentlyPlayedPending: boolean;
  madeForYouArtists: Artist[];
  madeForYouPlaylists: Playlist[];
  madeForYouAlbums: Album[];
  madeForYouPending: boolean;
  isPersonalized: boolean;
  podcasts: Podcast[];
  podcastsPending: boolean;
  popularAlbums: Album[];
  popularAlbumsPending: boolean;
  popularArtists: Artist[];
  popularArtistsPending: boolean;
  userPlaylists: Playlist[];
  userPlaylistsPending: boolean;
  tracks: Track[];
  tracksPending: boolean;
  t: ReturnType<typeof useTranslation>['t'];
  onSeedHoverIn: (colors: { primaryColor?: string; secondaryColor?: string }) => void;
  onSeedHoverOut: () => void;
  playTrackList: (tracks: Track[], startIndex?: number, context?: PlaybackContext) => Promise<void>;
  playAlbum: (albumId: string, albumName?: string) => void;
  playPlaylist: (playlistId: string, playlistName?: string) => void;
  playArtist: (artistId: string, artistName?: string) => void;
  addTrackToQueue: (track: Track) => void;
  addAlbumToQueue: (albumId: string) => void;
  addPlaylistToQueue: (playlistId: string) => void;
  addArtistToQueue: (artistId: string) => void;
}

/**
 * The home's content tree. Cards forward hover intent up via `onSeedHoverIn` /
 * `onSeedHoverOut`, which drive the app-wide ambient theme (the root provider
 * re-themes the WHOLE app from the hovered card's artwork). All data + handlers
 * are passed by `HomeScreen` (the data/logic owner) so this stays a pure
 * presentational tree.
 */
const HomeContent: React.FC<HomeContentProps> = ({
  greeting,
  liveRooms,
  quickAccess,
  quickAccessLoading,
  hasQuickAccess,
  hasMadeForYou,
  recentlyPlayed,
  recentlyPlayedPending,
  madeForYouArtists,
  madeForYouPlaylists,
  madeForYouAlbums,
  madeForYouPending,
  isPersonalized,
  podcasts,
  podcastsPending,
  popularAlbums,
  popularAlbumsPending,
  popularArtists,
  popularArtistsPending,
  userPlaylists,
  userPlaylistsPending,
  tracks,
  tracksPending,
  t,
  onSeedHoverIn,
  onSeedHoverOut,
  playTrackList,
  playAlbum,
  playPlaylist,
  playArtist,
  addTrackToQueue,
  addAlbumToQueue,
  addPlaylistToQueue,
  addArtistToQueue,
}) => {
  const theme = useTheme();
  const router = useRouter();
  const { joinLiveRoom } = useLiveRoom();

  return (
    <View style={[styles.gradientContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
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
                    onHoverIn={() => onSeedHoverIn({
                      primaryColor: item.data.primaryColor,
                      secondaryColor: item.data.secondaryColor,
                    })}
                    onHoverOut={onSeedHoverOut}
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
          {recentlyPlayedPending ? (
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
                      secondaryColor={track.secondaryColor}
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
                      onHoverIn={onSeedHoverIn}
                      onHoverOut={onSeedHoverOut}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </View>
          )}

          {/* Made for You — REAL recommendations (popular albums + public playlists) */}
          {madeForYouPending ? (
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
                      secondaryColor={artist.secondaryColor}
                      onPress={() => router.push(`/p/${artist.id}`)}
                      onPlayPress={() => playArtist(artist.id, artist.name)}
                      onAddToQueue={() => addArtistToQueue(artist.id)}
                      onHoverIn={onSeedHoverIn}
                      onHoverOut={onSeedHoverOut}
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
                      secondaryColor={playlist.secondaryColor}
                      onPress={() => router.push(`/playlist/${playlist.id}`)}
                      onPlayPress={() => playPlaylist(playlist.id, playlist.name)}
                      onAddToQueue={() => addPlaylistToQueue(playlist.id)}
                      onHoverIn={onSeedHoverIn}
                      onHoverOut={onSeedHoverOut}
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
                      secondaryColor={album.secondaryColor}
                      onPress={() => router.push(`/album/${album.id}`)}
                      onPlayPress={() => playAlbum(album.id, album.title)}
                      onAddToQueue={() => addAlbumToQueue(album.id)}
                      onGoToArtist={() => router.push(`/p/${album.artistId}`)}
                      onHoverIn={onSeedHoverIn}
                      onHoverOut={onSeedHoverOut}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </View>
          )}

          {/* Podcasts — popular shows from the public catalog. Mirrors the music
              rails (same MediaCard + ResponsiveGrid); "See all" opens the
              podcasts browse screen. Hidden when the catalog has no shows. */}
          {podcastsPending ? (
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
                      resolvedImageUri={pickCatalogImageUrl(undefined, podcast.image, 'card', podcast.imageSizes, podcast.imageSourceUrl)}
                      primaryColor={podcast.primaryColor}
                      secondaryColor={podcast.secondaryColor}
                      onPress={() => router.push({ pathname: '/podcasts/[id]', params: { id: podcast.id } })}
                      onPlayPress={() => router.push({ pathname: '/podcasts/[id]', params: { id: podcast.id } })}
                      onHoverIn={onSeedHoverIn}
                      onHoverOut={onSeedHoverOut}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </View>
          )}

          {/* Popular albums — REAL, ranked by catalog popularity */}
          {popularAlbumsPending ? (
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
                      secondaryColor={album.secondaryColor}
                      onPress={() => router.push(`/album/${album.id}`)}
                      onPlayPress={() => playAlbum(album.id, album.title)}
                      onAddToQueue={() => addAlbumToQueue(album.id)}
                      onGoToArtist={() => router.push(`/p/${album.artistId}`)}
                      onHoverIn={onSeedHoverIn}
                      onHoverOut={onSeedHoverOut}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </View>
          )}

          {/* Popular artists — REAL, ranked by catalog popularity */}
          {popularArtistsPending ? null : popularArtists.length > 0 && (
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
                      secondaryColor={artist.secondaryColor}
                      onPress={() => router.push(`/p/${artist.id}`)}
                      onPlayPress={() => playArtist(artist.id, artist.name)}
                      onAddToQueue={() => addArtistToQueue(artist.id)}
                      onHoverIn={onSeedHoverIn}
                      onHoverOut={onSeedHoverOut}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </View>
          )}

          {/* Your playlists — REAL, the signed-in user's own playlists */}
          {userPlaylistsPending ? null : userPlaylists.length > 0 && (
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
                      secondaryColor={playlist.secondaryColor}
                      onPress={() => router.push(`/playlist/${playlist.id}`)}
                      onPlayPress={() => playPlaylist(playlist.id, playlist.name)}
                      onAddToQueue={() => addPlaylistToQueue(playlist.id)}
                      onHoverIn={onSeedHoverIn}
                      onHoverOut={onSeedHoverOut}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </View>
          )}

          {/* Popular tracks — REAL, ranked by catalog popularity */}
          {tracksPending ? (
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
                      secondaryColor={track.secondaryColor}
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
                      onHoverIn={onSeedHoverIn}
                      onHoverOut={onSeedHoverOut}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </View>
          )}
        </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  gradientContainer: {
    flex: 1,
    overflow: 'hidden',
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
