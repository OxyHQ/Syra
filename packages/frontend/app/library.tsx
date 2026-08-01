import React, { useState, useMemo } from 'react';
import { StyleSheet, View, Text, Pressable, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@oxyhq/bloom/theme';
import SEO from '@/components/SEO';
import { LibraryListSkeleton } from '@/components/skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Fab } from '@/components/ui/Fab';
import { useAuthGate } from '@/hooks/useAuthGate';
import { useCollapseOnScroll } from '@/hooks/useCollapseOnScroll';
import { useLibraryCollections } from '@/hooks/useLibraryCollections';
import { PLAYER_BAR_HEIGHT } from '@/constants/layout';
import { Ionicons, Octicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Playlist, Album, Artist } from '@syra/shared-types';
import { Image } from 'expo-image';
import { pickCatalogImageUrl, resolvePodcastArtwork } from '@/utils/pickImage';
import { EpisodeRow } from '@/components/EpisodeRow';
import { useSubscriptions, useContinueListening } from '@/hooks/usePodcasts';
import { useUploads } from '@/hooks/useUploads';
import { usePlayerStore } from '@/stores/playerStore';
import { cn } from '@/lib/utils';

/**
 * Bottom offset (in px) for the Create Playlist FAB. Clears the floating
 * mobile player bar + bottom nav so the button never sits beneath them; on
 * web/desktop the player bar lives below the library panel so the offset is
 * just comfortable padding (`useSafeAreaInsets().bottom` is 0 on web). The
 * player-bar clearance derives from the shared `PLAYER_BAR_HEIGHT` so it never
 * drifts out of sync with the actual bar.
 */
const FAB_BOTTOM_OFFSET = 24;
const FAB_PLAYER_BAR_CLEARANCE = PLAYER_BAR_HEIGHT + 20;
const FAB_SIDE_OFFSET = 16;

// These stay English identifiers: they are the filter's VALUE (and the source of
// `LibraryFilter`), not its label. The label comes from the key maps below, so a
// translated UI never changes what the state machine compares against.
const LIBRARY_FILTERS = ['All', 'Playlists', 'Artists', 'Albums', 'Uploads', 'Podcasts', 'Episodes'] as const;
type LibraryFilter = (typeof LIBRARY_FILTERS)[number];

/** Chip label per filter. */
const LIBRARY_FILTER_KEYS: Record<LibraryFilter, string> = {
  All: 'common.all',
  Playlists: 'common.playlists',
  Artists: 'common.artists',
  Albums: 'common.albums',
  Uploads: 'uploads.locker.title',
  Podcasts: 'common.podcasts',
  Episodes: 'common.episodes',
};

/** Empty-state copy per filter, shown only once the library is known to be empty. */
const EMPTY_LIBRARY_KEYS: Record<LibraryFilter, string> = {
  All: 'library.empty.all',
  Playlists: 'library.empty.playlists',
  Artists: 'library.empty.artists',
  Albums: 'library.empty.albums',
  Uploads: 'uploads.locker.empty',
  Podcasts: 'library.empty.podcasts',
  Episodes: 'library.empty.episodes',
};

interface LibraryScreenProps {
  // Optional props for sidebar mode
  showSidebarControls?: boolean;
  isFullscreen?: boolean;
  onFullscreen?: () => void;
  onCollapse?: () => void;
  // Optional data props - if provided, use them instead of fetching
  playlists?: Playlist[];
  savedAlbums?: Album[];
  followedArtists?: Artist[];
  likedTracksCount?: number;
  loading?: boolean;
  error?: string | null;
}

/**
 * Syra Library Screen
 * User's music library (Liked Songs, Playlists, Artists, Albums)
 * Can be used as standalone screen or as sidebar component
 */
const LibraryScreen: React.FC<LibraryScreenProps> = ({
  showSidebarControls = false,
  isFullscreen = false,
  onFullscreen,
  onCollapse,
  playlists: propsPlaylists,
  savedAlbums: propsSavedAlbums,
  followedArtists: propsFollowedArtists,
  likedTracksCount: propsLikedTracksCount,
  loading: propsLoading,
  error: propsError,
}) => {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const gate = useAuthGate();
  const { t } = useTranslation();

  // Collapses the extended FAB to an icon-only circle while scrolling down and
  // re-expands it on upward scroll / near the top. Driven on the UI thread, so
  // no re-renders. 1 = expanded pill, 0 = collapsed circle.
  const { expanded: fabExpanded, scrollHandler } = useCollapseOnScroll();

  // Absolute positioning for the FAB. `insets.bottom` is its only dynamic
  // input, so memoize to keep the reference stable for the memoized `Fab`.
  const fabStyle = useMemo<ViewStyle>(
    () => ({
      position: 'absolute',
      right: FAB_SIDE_OFFSET,
      bottom: FAB_BOTTOM_OFFSET + FAB_PLAYER_BAR_CLEARANCE + insets.bottom,
    }),
    [insets.bottom]
  );

  // Filter state
  const [activeFilter, setActiveFilter] = useState<LibraryFilter>('All');

  // Podcasts vertical: subscribed shows + in-progress episodes.
  const subscriptionsQuery = useSubscriptions();
  const continueQuery = useContinueListening();
  const subscribedPodcasts = subscriptionsQuery.data?.subscriptions ?? [];
  const inProgressEpisodes = (continueQuery.data ?? []).filter((entry) => !entry.completed);
  // The listener's own uploads. Private by construction — a separate collection
  // no catalogue query reads — so they get their own entry rather than being
  // mixed into saved albums or playlists.
  const { uploads, total: uploadCount } = useUploads();
  const currentEpisode = usePlayerStore((s) => s.currentEpisode);
  const isEpisodePlaying = usePlayerStore((s) => s.isPlaying);
  const playEpisode = usePlayerStore((s) => s.playEpisode);

  // Use props if provided (sidebar mode), otherwise fetch via the shared
  // React Query library layer (standalone mode). The collections derive from
  // the `['library']` membership cache, so optimistic like/save/follow toggles
  // anywhere in the app keep these counts and lists in sync.
  const isUsingProps = propsPlaylists !== undefined;
  const collections = useLibraryCollections();

  const finalPlaylists = isUsingProps ? (propsPlaylists || []) : collections.playlists;
  const finalSavedAlbums = isUsingProps ? (propsSavedAlbums || []) : collections.savedAlbums;
  const finalFollowedArtists = isUsingProps ? (propsFollowedArtists || []) : collections.followedArtists;
  const finalLikedTracksCount = isUsingProps ? (propsLikedTracksCount || 0) : collections.likedTracksCount;
  const finalLoading = gate.isResolving || (isUsingProps ? (propsLoading ?? false) : collections.loading);
  // A session that never resolved is an error in BOTH modes — in sidebar mode
  // the parent passes data but not the session's terminal state, so an
  // unresolved auth would otherwise fall through to "your library is empty".
  const finalError = gate.isTimedOut
    ? t('library.errors.session')
    : isUsingProps ? (propsError ?? null) : collections.error;

  const isLibraryEmptyForFilter =
    (activeFilter === 'All' && finalPlaylists.length === 0 && finalFollowedArtists.length === 0 && finalSavedAlbums.length === 0 && subscribedPodcasts.length === 0 && inProgressEpisodes.length === 0) ||
    (activeFilter === 'Playlists' && finalPlaylists.length === 0) ||
    (activeFilter === 'Artists' && finalFollowedArtists.length === 0) ||
    (activeFilter === 'Albums' && finalSavedAlbums.length === 0) ||
    (activeFilter === 'Uploads' && uploads.length === 0) ||
    (activeFilter === 'Podcasts' && subscribedPodcasts.length === 0) ||
    (activeFilter === 'Episodes' && inProgressEpisodes.length === 0);

  return (
    <>
      {!showSidebarControls && (
        <SEO
          title={t('library.seo.title')}
          description={t('library.seo.description')}
        />
      )}
      <View className="flex-1 relative">
      <Animated.ScrollView
        className="flex-1"
        contentContainerClassName="px-3 pt-3 pb-[100px]"
        showsVerticalScrollIndicator={false}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
      >
        <View className="flex-row items-center justify-between mb-3">
          <Text className="text-[24px] font-bold text-foreground">{t('library.title')}</Text>
          <View className="flex-row gap-2 items-center">
            {showSidebarControls && onFullscreen && (
              <Pressable
                onPress={onFullscreen}
                className="w-7 h-7 items-center justify-center rounded-[14px] bg-popover web:cursor-pointer"
              >
                <Ionicons
                  name={isFullscreen ? 'contract' : 'expand'}
                  size={18}
                  color={theme.colors.text}
                />
              </Pressable>
            )}
            {showSidebarControls && onCollapse && !isFullscreen && (
              <Pressable
                onPress={onCollapse}
                className="w-7 h-7 items-center justify-center rounded-[14px] bg-popover web:cursor-pointer"
              >
                <Octicons
                  name="sidebar-collapse"
                  size={18}
                  color={theme.colors.text}
                />
              </Pressable>
            )}
          </View>
        </View>

        {/* Filters */}
        <View className="flex-row gap-1.5 mb-3 items-center">
          {LIBRARY_FILTERS.map((filter) => {
            const isActive = activeFilter === filter;
            return (
              <Pressable
                key={filter}
                onPress={() => setActiveFilter(filter)}
                className={cn(
                  'px-2.5 py-[3px] rounded-[12px] h-6 justify-center items-center',
                  isActive ? 'bg-primary' : 'bg-popover',
                )}
              >
                <Text
                  className={cn(
                    'text-[11px] leading-[13px]',
                    isActive ? 'font-bold text-primary-foreground' : 'font-semibold text-foreground',
                  )}
                >
                  {t(LIBRARY_FILTER_KEYS[filter])}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Liked Songs - show only when All or Playlists filter is active */}
        {gate.isAuthenticated && (activeFilter === 'All' || activeFilter === 'Playlists') && (
          <Pressable
            className="flex-row items-center gap-3 p-2 rounded-[6px] mb-2 bg-popover"
            onPress={() => router.push('/library/liked')}
          >
            <View className="w-12 h-12 rounded-[4px] items-center justify-center bg-primary">
              <Ionicons name="heart" size={24} color={theme.colors.primaryForeground} />
            </View>
            <View className="flex-1">
              <Text className="text-[14px] font-semibold mb-0.5 text-foreground">{t('library.likedSongs')}</Text>
              <Text className="text-[12px] text-muted-foreground">
                Playlist • {finalLoading ? '...' : `${finalLikedTracksCount} ${finalLikedTracksCount === 1 ? 'song' : 'songs'}`}
              </Text>
            </View>
          </Pressable>
        )}

        {/* Your uploads — the private locker, alongside Liked Songs rather than
            inside the saved-album lists, because nothing in it is catalogue. */}
        {gate.isAuthenticated && (activeFilter === 'All' || activeFilter === 'Uploads') && uploads.length > 0 && (
          <Pressable
            className="flex-row items-center gap-3 p-2 rounded-[6px] mb-2 bg-popover"
            onPress={() => router.push('/library/uploads')}
          >
            <View className="w-12 h-12 rounded-[4px] items-center justify-center bg-surface">
              <MaterialCommunityIcons name="folder-music" size={24} color={theme.colors.text} />
            </View>
            <View className="flex-1">
              <Text className="text-[14px] font-semibold mb-0.5 text-foreground">{t('uploads.locker.title')}</Text>
              <Text className="text-[12px] text-muted-foreground">
                {t('uploads.locker.trackCount', { count: uploadCount })}
              </Text>
            </View>
          </Pressable>
        )}

        {/* Loading state */}
        {finalLoading && (gate.isAuthenticated || gate.isResolving) && (
          <View className="mb-6">
            <Text className="text-[16px] font-bold mb-3 text-foreground">{t('common.playlists')}</Text>
            <View className="gap-0">
              <LibraryListSkeleton count={6} />
            </View>
          </View>
        )}

        {/* Error state — always offers a retry, including the auth timeout */}
        {finalError && !finalLoading && (
          <EmptyState
            containerStyle={styles.inlineState}
            icon={{ name: 'cloud-offline-outline' }}
            error={{
              title: t('library.errors.load'),
              message: finalError,
              onRetry: collections.retry,
            }}
          />
        )}

        {/* Playlists list */}
        {!finalLoading && !finalError && finalPlaylists.length > 0 && (activeFilter === 'All' || activeFilter === 'Playlists') && (
          <View className="mb-6">
            <Text className="text-[16px] font-bold mb-3 text-foreground">{t('common.playlists')}</Text>
            <View className="gap-0">
              {finalPlaylists.map((playlist) => (
                <Pressable
                  key={playlist.id}
                  className="flex-row items-center gap-3 p-2 rounded-[6px] mb-2 bg-popover"
                  onPress={() => router.push(`/playlist/${playlist.id}`)}
                >
                  {playlist.coverArt ? (
                    <Image
                      source={{ uri: pickCatalogImageUrl(undefined, playlist.coverArt, 'thumbnail', playlist.coverArtSizes) }}
                      style={styles.squareArtwork}
                      contentFit="cover"
                    />
                  ) : (
                    <View className="w-12 h-12 rounded-[4px] items-center justify-center bg-background">
                      <MaterialCommunityIcons
                        name="playlist-music"
                        size={24}
                        color={theme.colors.textSecondary}
                      />
                    </View>
                  )}
                  <View className="flex-1">
                    <Text className="text-[14px] font-semibold mb-0.5 text-foreground" numberOfLines={1}>
                      {playlist.name}
                    </Text>
                    <Text className="text-[12px] text-muted-foreground">
                      {playlist.visibility === 'public' ? t('common.public') : t('common.private')} • {t('common.songCount', { count: playlist.trackCount || 0 })}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* Artists list */}
        {!finalLoading && !finalError && finalFollowedArtists.length > 0 && (activeFilter === 'All' || activeFilter === 'Artists') && (
          <View className="mb-6">
            <Text className="text-[16px] font-bold mb-3 text-foreground">{t('common.artists')}</Text>
            <View className="gap-0">
              {finalFollowedArtists.map((artist) => (
                <Pressable
                  key={artist.id}
                  className="flex-row items-center gap-3 p-2 rounded-[6px] mb-2 bg-popover"
                  onPress={() => router.push(`/p/${artist.id}`)}
                >
                  {(artist.image || artist.images?.length) ? (
                    <Image
                      source={{ uri: pickCatalogImageUrl(artist.images, artist.image, 'thumbnail', artist.imageSizes) }}
                      style={styles.roundArtwork}
                      contentFit="cover"
                    />
                  ) : (
                    <View className="w-12 h-12 rounded-[24px] items-center justify-center bg-background">
                      <Ionicons
                        name="person"
                        size={24}
                        color={theme.colors.textSecondary}
                      />
                    </View>
                  )}
                  <View className="flex-1">
                    <Text className="text-[14px] font-semibold mb-0.5 text-foreground" numberOfLines={1}>
                      {artist.name}
                    </Text>
                    <Text className="text-[12px] text-muted-foreground">
                      {t('common.artist')}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* Albums list */}
        {!finalLoading && !finalError && finalSavedAlbums.length > 0 && (activeFilter === 'All' || activeFilter === 'Albums') && (
          <View className="mb-6">
            <Text className="text-[16px] font-bold mb-3 text-foreground">{t('common.albums')}</Text>
            <View className="gap-0">
              {finalSavedAlbums.map((album) => (
                <Pressable
                  key={album.id}
                  className="flex-row items-center gap-3 p-2 rounded-[6px] mb-2 bg-popover"
                  onPress={() => router.push(`/album/${album.id}`)}
                >
                  {album.coverArt ? (
                    <Image
                      source={{ uri: pickCatalogImageUrl(undefined, album.coverArt, 'thumbnail', album.coverArtSizes) }}
                      style={styles.squareArtwork}
                      contentFit="cover"
                    />
                  ) : (
                    <View className="w-12 h-12 rounded-[4px] items-center justify-center bg-background">
                      <MaterialCommunityIcons
                        name="album"
                        size={24}
                        color={theme.colors.textSecondary}
                      />
                    </View>
                  )}
                  <View className="flex-1">
                    <Text className="text-[14px] font-semibold mb-0.5 text-foreground" numberOfLines={1}>
                      {album.title}
                    </Text>
                    <Text className="text-[12px] text-muted-foreground">
                      {album.artistName} • {album.releaseDate ? new Date(album.releaseDate).getFullYear() : ''}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* Subscribed podcasts */}
        {gate.isAuthenticated && (activeFilter === 'All' || activeFilter === 'Podcasts') && subscribedPodcasts.length > 0 && (
          <View className="mb-6">
            <Text className="text-[16px] font-bold mb-3 text-foreground">{t('common.podcasts')}</Text>
            <View className="gap-0">
              {subscribedPodcasts.map(({ podcast }) => {
                const imageUri = resolvePodcastArtwork(podcast, 'thumbnail');
                return (
                  <Pressable
                    key={podcast.id}
                    className="flex-row items-center gap-3 p-2 rounded-[6px] mb-2 bg-popover"
                    onPress={() => router.push({ pathname: '/podcasts/[id]', params: { id: podcast.id } })}
                  >
                    {imageUri ? (
                      <Image source={{ uri: imageUri }} style={styles.squareArtwork} contentFit="cover" />
                    ) : (
                      <View className="w-12 h-12 rounded-[4px] items-center justify-center bg-background">
                        <MaterialCommunityIcons name="podcast" size={24} color={theme.colors.textSecondary} />
                      </View>
                    )}
                    <View className="flex-1">
                      <Text className="text-[14px] font-semibold mb-0.5 text-foreground" numberOfLines={1}>
                        {podcast.title}
                      </Text>
                      <Text className="text-[12px] text-muted-foreground" numberOfLines={1}>
                        {podcast.author ?? t('common.podcast')}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        {/* In-progress episodes */}
        {gate.isAuthenticated && (activeFilter === 'All' || activeFilter === 'Episodes') && inProgressEpisodes.length > 0 && (
          <View className="mb-6">
            <Text className="text-[16px] font-bold mb-3 text-foreground">{t('library.continueListening')}</Text>
            <View className="gap-0">
              {inProgressEpisodes.map((entry) => (
                <EpisodeRow
                  key={entry.episode.id}
                  episode={entry.episode}
                  progress={{ progressSec: entry.progressSec, durationSec: entry.durationSec, completed: entry.completed }}
                  isCurrent={currentEpisode?.id === entry.episode.id}
                  isPlaying={currentEpisode?.id === entry.episode.id && isEpisodePlaying}
                  onPress={() => router.push({ pathname: '/episode/[id]', params: { id: entry.episode.id } })}
                  onPlayPress={() => playEpisode(entry.episode, { resumeFromSec: entry.progressSec })}
                />
              ))}
            </View>
          </View>
        )}

        {/* Empty state — only once the session resolved AND the queries settled,
            so an unresolved auth is never mistaken for an empty library. */}
        {!finalLoading && !finalError && gate.canUsePrivateApi && isLibraryEmptyForFilter && (
          <EmptyState
            containerStyle={styles.inlineState}
            icon={{ name: 'musical-notes-outline' }}
            title={t(EMPTY_LIBRARY_KEYS[activeFilter])}
            action={
              activeFilter === 'Playlists'
                ? { label: t('library.createFirstPlaylist'), onPress: () => router.push('/create-playlist') }
                : activeFilter === 'Uploads'
                  ? { label: t('uploads.title'), onPress: () => router.push('/upload') }
                  : undefined
            }
          />
        )}

        {/* Signed out — a terminal state, distinct from a session still resolving */}
        {gate.status === 'guest' && !finalLoading && (
          <EmptyState
            containerStyle={styles.inlineState}
            icon={{ name: 'lock-closed-outline' }}
            title={t('library.signedOut')}
          />
        )}
      </Animated.ScrollView>

        {gate.canUsePrivateApi && (
          <Fab
            onPress={() => router.push('/create-playlist')}
            iconName="plus"
            accessibilityLabel={t('library.createPlaylist')}
            label={t('library.createPlaylist')}
            expanded={fabExpanded}
            size={showSidebarControls ? 48 : 56}
            style={fabStyle}
          />
        )}
      </View>
    </>
  );
};

// The only styles left are the ones no NativeWind class can reach: `expo-image`
// has no `className` prop, and `EmptyState` takes a `ViewStyle` through
// `containerStyle` rather than a class.
const styles = StyleSheet.create({
  // States rendered INSIDE the scroll view: no `flex: 1` stretch and no opaque
  // background of their own, so they sit inline under the filter row.
  inlineState: {
    flex: 0,
    paddingVertical: 32,
    backgroundColor: 'transparent',
  },
  squareArtwork: {
    width: 48,
    height: 48,
    borderRadius: 4,
  },
  roundArtwork: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
});

export default LibraryScreen;
