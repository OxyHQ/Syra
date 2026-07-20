import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { StyleSheet, View, ScrollView, Text, Platform, Pressable } from 'react-native';
import { useTheme, useAmbientTheme } from '@oxyhq/bloom/theme';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useOxy } from '@oxyhq/services';
import { RoomCard, useLiveRoom, createRoomsService, type Room } from '@syra.fm/sdk';
import SEO from '@/components/SEO';
import { MediaCard } from '@/components/MediaCard';
import { ResponsiveGrid } from '@/components/ResponsiveGrid';
import { EmptyState } from '@/components/common/EmptyState';
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
  useHomePodcasts,
  type HomeSectionStatus,
} from '@/hooks/useHomeFeed';
import { usePlayEntity } from '@/hooks/usePlayEntity';
import { createScopedLogger } from '@/utils/logger';
import { Ionicons } from '@expo/vector-icons';
import { pickCatalogImageUrl, resolvePodcastArtwork } from '@/utils/pickImage';
import { authenticatedClient } from '@/utils/api';
import { liveRoomsQueryKey } from '@/lib/liveConfig';
import { toast } from '@/lib/sonner';

const logger = createScopedLogger('HomeScreen');

/** Shared copy for a failed section — the cause is always the same from here. */

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
 * data fetching.
 *
 * Every section resolves to a terminal state: content, an error card with a
 * retry, a sign-in call to action for the two account-only rails, or nothing at
 * all when a successful request came back empty. A skeleton is only ever shown
 * while a request is actually in flight.
 */
const HomeScreen: React.FC = () => {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => new Date());
  const { playTrackList } = usePlayerStore();
  const { addTracksLocally } = useQueueStore();
  const { openAccountDialog } = useOxy();
  // Album / playlist / artist / show play buttons all resolve through the one
  // shared hook, so every card that offers play behaves identically here and on
  // the other browse surfaces.
  const { playAlbum, playPlaylist, playArtist, playPodcast } = usePlayEntity();
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

  // Real, per-section queries — each reports its own terminal status.
  const recentlyPlayedSection = useRecentlyPlayed();
  const madeForYouSection = useMadeForYou();
  const popularAlbumsSection = usePopularAlbums();
  const popularArtistsSection = usePopularArtists();
  const userPlaylistsSection = useUserPlaylists();
  const tracksSection = usePopularTracks();
  // Podcasts — popular shows from the public catalog; runs for guests too.
  const podcastsSection = useHomePodcasts();

  // Live rooms — the same fetch the Live surface uses (public, error-swallowing:
  // `getRooms` returns `[]` on failure/no-auth, so the section is terminal by
  // construction — it simply disappears when nothing is live). Keyed off the
  // shared `liveRoomsQueryKey` so it shares one cache authority with `app/live.tsx`.
  const roomsService = useMemo(() => createRoomsService(authenticatedClient), []);
  const liveRoomsQuery = useQuery({
    queryKey: liveRoomsQueryKey,
    queryFn: () => roomsService.getRooms('live'),
    staleTime: 30_000,
  });

  // Derive section data from the queries (empty arrays until they resolve).
  const recentlyPlayed = useMemo<Track[]>(
    () => recentlyPlayedSection.data?.tracks ?? [],
    [recentlyPlayedSection.data],
  );
  const madeForYouAlbums = useMemo<Album[]>(
    () => madeForYouSection.data?.albums ?? [],
    [madeForYouSection.data],
  );
  const madeForYouPlaylists = useMemo<Playlist[]>(
    () => madeForYouSection.data?.playlists ?? [],
    [madeForYouSection.data],
  );
  const madeForYouArtists = useMemo<Artist[]>(
    () => madeForYouSection.data?.artists ?? [],
    [madeForYouSection.data],
  );
  const isPersonalized = useMemo<boolean>(
    () => madeForYouSection.data?.personalized === true,
    [madeForYouSection.data],
  );
  const popularAlbums = useMemo<Album[]>(
    () => popularAlbumsSection.data?.albums ?? [],
    [popularAlbumsSection.data],
  );
  const popularArtists = useMemo<Artist[]>(
    () => popularArtistsSection.data?.artists ?? [],
    [popularArtistsSection.data],
  );
  const userPlaylists = useMemo<Playlist[]>(
    () => userPlaylistsSection.data?.playlists ?? [],
    [userPlaylistsSection.data],
  );
  const tracks = useMemo<Track[]>(
    () => tracksSection.data?.tracks ?? [],
    [tracksSection.data],
  );
  const liveRooms = useMemo<Room[]>(
    () => liveRoomsQuery.data ?? [],
    [liveRoomsQuery.data],
  );
  const podcasts = useMemo<Podcast[]>(
    () => podcastsSection.data ?? [],
    [podcastsSection.data],
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

  const handleSignIn = useCallback(() => {
    openAccountDialog('signin');
  }, [openAccountDialog]);

  const addTrackToQueue = useCallback((track: Track) => {
    addTracksLocally([track], 'last');
    toast.success(t('home.toasts.addedToQueue'));
  }, [addTracksLocally]);

  const addAlbumToQueue = useCallback(async (albumId: string) => {
    try {
      const { tracks: albumTracks } = await musicService.getAlbumTracks(albumId);
      if (albumTracks.length === 0) {
        toast.info(t('home.toasts.noTracksToAdd'));
        return;
      }
      addTracksLocally(albumTracks, 'last');
      toast.success(t('home.toasts.addedToQueue'));
    } catch (error) {
      logger.error('Error adding album to queue', { albumId, error });
      toast.error(t('home.toasts.addToQueueFailed'));
    }
  }, [addTracksLocally]);

  const addPlaylistToQueue = useCallback(async (playlistId: string) => {
    try {
      const { tracks: playlistTracks } = await musicService.getPlaylistTracks(playlistId);
      if (playlistTracks.length === 0) {
        toast.info(t('home.toasts.noTracksToAdd'));
        return;
      }
      addTracksLocally(playlistTracks, 'last');
      toast.success(t('home.toasts.addedToQueue'));
    } catch (error) {
      logger.error('Error adding playlist to queue', { playlistId, error });
      toast.error(t('home.toasts.addToQueueFailed'));
    }
  }, [addTracksLocally]);

  const addArtistToQueue = useCallback(async (artistId: string) => {
    try {
      const { tracks: artistTracks } = await musicService.getArtistTracks(artistId, { limit: 50 });
      if (artistTracks.length === 0) {
        toast.info(t('home.toasts.noTracksToAdd'));
        return;
      }
      addTracksLocally(artistTracks, 'last');
      toast.success(t('home.toasts.addedToQueue'));
    } catch (error) {
      logger.error('Error adding artist to queue', { artistId, error });
      toast.error(t('home.toasts.addToQueueFailed'));
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

  return (
    <>
      <SEO
        title={t('home.seo.title')}
        description={t('home.seo.description')}
      />
      {/* Hovering any card themes the WHOLE app from that card's artwork; leaving
          restores the default. Theming is owned by Bloom's ambient store (fed via
          `useAmbientTheme`) and applied by the root `BloomThemeProvider` — no
          per-screen theme wrapper. */}
      <HomeContent
          greeting={greeting}
          liveRooms={liveRooms}
          quickAccess={quickAccess}
          /* Quick access, "Made for you", the popular rails and the track list
             are all served by ONE browse request, so they share one status and
             one retry — and only the top block renders the error card. */
          browseStatus={madeForYouSection.status}
          onRetryBrowse={madeForYouSection.retry}
          /* A session that never resolved fails every gated rail at once, so it
             is reported once at the top instead of once per rail. */
          sessionBlocked={madeForYouSection.blockedBySession}
          recentlyPlayed={recentlyPlayed}
          recentlyPlayedStatus={recentlyPlayedSection.status}
          onRetryRecentlyPlayed={recentlyPlayedSection.retry}
          madeForYouArtists={madeForYouArtists}
          madeForYouPlaylists={madeForYouPlaylists}
          madeForYouAlbums={madeForYouAlbums}
          isPersonalized={isPersonalized}
          podcasts={podcasts}
          podcastsStatus={podcastsSection.status}
          onRetryPodcasts={podcastsSection.retry}
          popularAlbums={popularAlbums}
          popularArtists={popularArtists}
          userPlaylists={userPlaylists}
          userPlaylistsStatus={userPlaylistsSection.status}
          onRetryUserPlaylists={userPlaylistsSection.retry}
          tracks={tracks}
          t={t}
          onSignIn={handleSignIn}
          onSeedHoverIn={handleHoverIn}
          onSeedHoverOut={handleHoverOut}
          playTrackList={playTrackList}
          playAlbum={playAlbum}
          playPlaylist={playPlaylist}
          playArtist={playArtist}
          playPodcast={playPodcast}
          addTrackToQueue={addTrackToQueue}
          addAlbumToQueue={addAlbumToQueue}
          addPlaylistToQueue={addPlaylistToQueue}
          addArtistToQueue={addArtistToQueue}
        />
    </>
  );
};

interface HomeSectionBlockProps {
  title: string;
  status: HomeSectionStatus;
  /** Whether the resolved section actually has something to render. */
  hasContent: boolean;
  skeleton: React.ReactNode;
  onRetry: () => Promise<void>;
  /**
   * Copy for this section's error card. Omitted when a sibling section already
   * reports the failure of the same request — one error card per request.
   */
  error?: { title: string; message: string };
  /** The sign-in call to action. Omitted for sections guests can see. */
  signedOut?: { title: string; subtitle: string; onSignIn: () => void };
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * One titled home rail, resolved to exactly one terminal state.
 *
 * The section renders nothing when a successful request came back empty, when
 * another section owns the error for the same request, or when a guest-visible
 * section has no sign-in copy to offer.
 */
const HomeSectionBlock: React.FC<HomeSectionBlockProps> = ({
  title,
  status,
  hasContent,
  skeleton,
  onRetry,
  error,
  signedOut,
  headerAction,
  children,
}) => {
  const { t } = useTranslation();
  const theme = useTheme();

  if (
    (status === 'ready' && !hasContent) ||
    (status === 'error' && !error) ||
    (status === 'signed-out' && !signedOut)
  ) {
    return null;
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <Text style={[styles.sectionHeaderTitle, { color: theme.colors.text }]}>{title}</Text>
        {headerAction}
      </View>
      {status === 'loading' ? (
        skeleton
      ) : status === 'error' && error ? (
        <EmptyState
          icon={{ name: 'cloud-offline-outline' }}
          error={{ title: error.title, message: error.message, onRetry }}
          containerStyle={styles.sectionState}
        />
      ) : status === 'signed-out' && signedOut ? (
        <EmptyState
          icon={{ name: 'person-circle-outline' }}
          title={signedOut.title}
          subtitle={signedOut.subtitle}
          action={{ label: t('common.signIn'), onPress: signedOut.onSignIn, icon: 'log-in-outline' }}
          containerStyle={styles.sectionState}
        />
      ) : (
        children
      )}
    </View>
  );
};

interface HomeContentProps {
  greeting: string;
  liveRooms: Room[];
  quickAccess: QuickAccessItem[];
  browseStatus: HomeSectionStatus;
  onRetryBrowse: () => Promise<void>;
  sessionBlocked: boolean;
  recentlyPlayed: Track[];
  recentlyPlayedStatus: HomeSectionStatus;
  onRetryRecentlyPlayed: () => Promise<void>;
  madeForYouArtists: Artist[];
  madeForYouPlaylists: Playlist[];
  madeForYouAlbums: Album[];
  isPersonalized: boolean;
  podcasts: Podcast[];
  podcastsStatus: HomeSectionStatus;
  onRetryPodcasts: () => Promise<void>;
  popularAlbums: Album[];
  popularArtists: Artist[];
  userPlaylists: Playlist[];
  userPlaylistsStatus: HomeSectionStatus;
  onRetryUserPlaylists: () => Promise<void>;
  tracks: Track[];
  t: ReturnType<typeof useTranslation>['t'];
  onSignIn: () => void;
  onSeedHoverIn: (colors: { primaryColor?: string; secondaryColor?: string }) => void;
  onSeedHoverOut: () => void;
  playTrackList: (tracks: Track[], startIndex?: number, context?: PlaybackContext) => Promise<void>;
  playAlbum: (albumId: string, albumName?: string) => void;
  playPlaylist: (playlistId: string, playlistName?: string) => void;
  playArtist: (artistId: string, artistName?: string) => void;
  playPodcast: (podcastId: string, podcastTitle?: string) => void;
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
  browseStatus,
  onRetryBrowse,
  sessionBlocked,
  recentlyPlayed,
  recentlyPlayedStatus,
  onRetryRecentlyPlayed,
  madeForYouArtists,
  madeForYouPlaylists,
  madeForYouAlbums,
  isPersonalized,
  podcasts,
  podcastsStatus,
  onRetryPodcasts,
  popularAlbums,
  popularArtists,
  userPlaylists,
  userPlaylistsStatus,
  onRetryUserPlaylists,
  tracks,
  t,
  onSignIn,
  onSeedHoverIn,
  onSeedHoverOut,
  playTrackList,
  playAlbum,
  playPlaylist,
  playArtist,
  playPodcast,
  addTrackToQueue,
  addAlbumToQueue,
  addPlaylistToQueue,
  addArtistToQueue,
}) => {
  const theme = useTheme();
  const router = useRouter();
  const { joinLiveRoom } = useLiveRoom();

  // Whether the browse request returned any music at all, across every rail it
  // feeds. Podcasts are excluded deliberately: they are a separate catalogue
  // with its own source, and they stay populated when music is empty.
  const hasAnyMusic =
    quickAccess.length > 0 ||
    madeForYouArtists.length > 0 ||
    madeForYouPlaylists.length > 0 ||
    madeForYouAlbums.length > 0 ||
    popularAlbums.length > 0 ||
    popularArtists.length > 0 ||
    tracks.length > 0;

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
              fetch + RoomCard; hidden entirely when nothing is live (the fetch
              swallows its own errors and returns an empty list). */}
          {liveRooms.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <View style={styles.liveHeading}>
                  <View style={[styles.liveDot, { backgroundColor: theme.colors.error }]} />
                  <Text style={[styles.sectionHeaderTitle, { color: theme.colors.text }]}>
                    {t('home.liveNow')}
                  </Text>
                </View>
                <Pressable style={styles.seeAllButton} onPress={() => router.push('/live')} hitSlop={8}>
                  <Text style={[styles.seeAll, { color: theme.colors.textSecondary }]}>
                    {t('common.seeAll')}
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

          {/* 8-Item Compact Grid (2 columns) - real albums/artists/playlists.
              This untitled block is the browse request's error owner: when the
              home feed fails it shows the single retry card for every rail the
              same request backs. */}
          {browseStatus === 'loading' ? (
            <QuickAccessGridSkeleton />
          ) : browseStatus === 'error' ? (
            <EmptyState
              icon={{ name: sessionBlocked ? 'person-circle-outline' : 'cloud-offline-outline' }}
              error={
                sessionBlocked
                  ? {
                      title: t('home.errors.session'),
                      message: t('home.errors.sessionMessage'),
                      onRetry: onRetryBrowse,
                    }
                  : {
                      title: t('home.errors.homeFeed'),
                      message: t('common.retryHint'),
                      onRetry: onRetryBrowse,
                    }
              }
              containerStyle={styles.sectionState}
            />
          ) : quickAccess.length > 0 ? (
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
          ) : null}

          {/* Every music rail on this screen is served by the one browse
              request, and each hides itself when it has nothing to show. So a
              catalogue with no music in it would collapse the whole screen to a
              greeting and a podcast rail, with no explanation. Syra's catalogue
              is built from creator uploads, which makes "empty" a real state
              with a real reason — not a failure, and not a blank page. */}
          {browseStatus === 'ready' && !hasAnyMusic && (
            <EmptyState
              icon={{ name: 'musical-notes-outline' }}
              title={t('home.empty.title')}
              subtitle={t('home.empty.subtitle')}
              action={{
                label: t('home.empty.action'),
                onPress: () => router.push('/podcasts'),
                icon: 'mic-outline',
              }}
              containerStyle={styles.sectionState}
            />
          )}

          {/* Jump back in — REAL recently-played tracks. Account-only: guests
              get a sign-in call to action instead of a permanent skeleton. */}
          <HomeSectionBlock
            title={t('home.sections.jumpBackIn')}
            status={recentlyPlayedStatus}
            hasContent={recentlyPlayed.length > 0}
            skeleton={<MediaCardRowSkeleton count={5} />}
            onRetry={onRetryRecentlyPlayed}
            error={sessionBlocked ? undefined : { title: t('home.errors.recentPlays'), message: t('common.retryHint') }}
            signedOut={{
              title: t('home.signedOut.recentTitle'),
              subtitle: t('home.signedOut.recentSubtitle'),
              onSignIn,
            }}
          >
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
          </HomeSectionBlock>

          {/* Made for You — REAL recommendations (popular albums + public playlists) */}
          <HomeSectionBlock
            title={t('common.madeForYou')}
            status={browseStatus}
            hasContent={
              madeForYouArtists.length > 0 ||
              madeForYouPlaylists.length > 0 ||
              madeForYouAlbums.length > 0
            }
            skeleton={<MediaCardRowSkeleton count={5} />}
            onRetry={onRetryBrowse}
          >
            <ResponsiveGrid minItemWidth={180} gap={8}>
              {madeForYouArtists.map((artist) => (
                <View key={artist.id}>
                  <MediaCard
                    title={artist.name}
                    subtitle={t('common.artist')}
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
          </HomeSectionBlock>

          {/* Podcasts — popular shows from the public catalog. Mirrors the music
              rails (same MediaCard + ResponsiveGrid); "See all" opens the
              podcasts browse screen. Public, so guests see it too. */}
          <HomeSectionBlock
            title={t('common.podcasts')}
            status={podcastsStatus}
            hasContent={podcasts.length > 0}
            skeleton={<MediaCardRowSkeleton count={5} />}
            onRetry={onRetryPodcasts}
            error={{ title: t('home.errors.podcasts'), message: t('common.retryHint') }}
            headerAction={
              <Pressable style={styles.seeAllButton} onPress={() => router.push('/podcasts')} hitSlop={8}>
                <Text style={[styles.seeAll, { color: theme.colors.textSecondary }]}>
                  {t('common.seeAll')}
                </Text>
              </Pressable>
            }
          >
            <ResponsiveGrid minItemWidth={180} gap={8}>
              {podcasts.map((podcast) => (
                <View key={podcast.id}>
                  <MediaCard
                    title={podcast.title}
                    subtitle={podcast.author ?? t('common.podcast')}
                    type="podcast"
                    resolvedImageUri={resolvePodcastArtwork(podcast, 'card')}
                    primaryColor={podcast.primaryColor}
                    secondaryColor={podcast.secondaryColor}
                    onPress={() => router.push({ pathname: '/podcasts/[id]', params: { id: podcast.id } })}
                    onPlayPress={() => playPodcast(podcast.id, podcast.title)}
                    onHoverIn={onSeedHoverIn}
                    onHoverOut={onSeedHoverOut}
                  />
                </View>
              ))}
            </ResponsiveGrid>
          </HomeSectionBlock>

          {/* Popular albums — REAL, ranked by catalog popularity */}
          <HomeSectionBlock
            title={t('home.sections.popularAlbums')}
            status={browseStatus}
            hasContent={popularAlbums.length > 0}
            skeleton={<MediaCardRowSkeleton count={5} />}
            onRetry={onRetryBrowse}
          >
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
          </HomeSectionBlock>

          {/* Popular artists — REAL, ranked by catalog popularity */}
          <HomeSectionBlock
            title={t('home.sections.popularArtists')}
            status={browseStatus}
            hasContent={popularArtists.length > 0}
            skeleton={<MediaCardRowSkeleton count={5} />}
            onRetry={onRetryBrowse}
          >
            <ResponsiveGrid minItemWidth={180} gap={8}>
              {popularArtists.map((artist) => (
                <View key={artist.id}>
                  <MediaCard
                    title={artist.name}
                    subtitle={t('common.artist')}
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
          </HomeSectionBlock>

          {/* Your playlists — REAL, the signed-in user's own playlists.
              Account-only: guests get a sign-in call to action. */}
          <HomeSectionBlock
            title={t('home.sections.yourPlaylists')}
            status={userPlaylistsStatus}
            hasContent={userPlaylists.length > 0}
            skeleton={<MediaCardRowSkeleton count={5} />}
            onRetry={onRetryUserPlaylists}
            error={sessionBlocked ? undefined : { title: t('home.errors.playlists'), message: t('common.retryHint') }}
            signedOut={{
              title: t('home.signedOut.playlistsTitle'),
              subtitle: t('home.signedOut.playlistsSubtitle'),
              onSignIn,
            }}
          >
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
          </HomeSectionBlock>

          {/* Popular tracks — REAL, ranked by catalog popularity */}
          <HomeSectionBlock
            title={t('common.popularTracks')}
            status={browseStatus}
            hasContent={tracks.length > 0}
            skeleton={<MediaCardRowSkeleton count={10} />}
            onRetry={onRetryBrowse}
          >
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
          </HomeSectionBlock>

          {/* Legal. Filing a copyright report is a PUBLIC flow — the endpoint
              takes no auth because rights holders are usually not Syra users —
              but Settings, the other entry point, is behind the sign-in wall.
              Home is the one surface every visitor reaches, so the publicly
              reachable entry point lives here. */}
          <View style={styles.footer}>
            <Pressable
              onPress={() => router.push('/copyright/report')}
              hitSlop={8}
              accessibilityRole="link"
              accessibilityLabel={t('common.reportCopyright')}
            >
              <Text style={[styles.footerLink, { color: theme.colors.textSecondary }]}>
                {t('common.reportCopyright')}
              </Text>
            </Pressable>
          </View>
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
  // `EmptyState` is built to fill a screen; inside a rail it has to size to its
  // own content instead of stretching, and sit on the home background.
  sectionState: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    backgroundColor: 'transparent',
    paddingVertical: 24,
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
  footer: {
    paddingTop: 4,
    paddingBottom: 8,
  },
  footerLink: {
    fontSize: 13,
    fontWeight: '500',
    textDecorationLine: 'underline',
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
});

export default HomeScreen;
