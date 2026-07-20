import React, { useState, useMemo } from 'react';
import { StyleSheet, View, Text, Pressable, Platform } from 'react-native';
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
import { usePlayerStore } from '@/stores/playerStore';

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

const LIBRARY_FILTERS = ['All', 'Playlists', 'Artists', 'Albums', 'Podcasts', 'Episodes'] as const;
type LibraryFilter = (typeof LIBRARY_FILTERS)[number];

/** Empty-state copy per filter, shown only once the library is known to be empty. */
const EMPTY_LIBRARY_TEXT: Record<LibraryFilter, string> = {
  All: 'Your library is empty',
  Playlists: 'No playlists yet',
  Artists: 'No followed artists yet',
  Albums: 'No saved albums yet',
  Podcasts: 'No podcast subscriptions yet',
  Episodes: 'No episodes in progress',
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
  const fabStyle = useMemo(
    () => [
      styles.fab,
      {
        right: FAB_SIDE_OFFSET,
        bottom: FAB_BOTTOM_OFFSET + FAB_PLAYER_BAR_CLEARANCE + insets.bottom,
      },
    ],
    [insets.bottom]
  );

  // Filter state
  const [activeFilter, setActiveFilter] = useState<LibraryFilter>('All');

  // Podcasts vertical: subscribed shows + in-progress episodes.
  const subscriptionsQuery = useSubscriptions();
  const continueQuery = useContinueListening();
  const subscribedPodcasts = subscriptionsQuery.data?.subscriptions ?? [];
  const inProgressEpisodes = (continueQuery.data ?? []).filter((entry) => !entry.completed);
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
    ? 'We could not confirm your session.'
    : isUsingProps ? (propsError ?? null) : collections.error;

  const isLibraryEmptyForFilter =
    (activeFilter === 'All' && finalPlaylists.length === 0 && finalFollowedArtists.length === 0 && finalSavedAlbums.length === 0 && subscribedPodcasts.length === 0 && inProgressEpisodes.length === 0) ||
    (activeFilter === 'Playlists' && finalPlaylists.length === 0) ||
    (activeFilter === 'Artists' && finalFollowedArtists.length === 0) ||
    (activeFilter === 'Albums' && finalSavedAlbums.length === 0) ||
    (activeFilter === 'Podcasts' && subscribedPodcasts.length === 0) ||
    (activeFilter === 'Episodes' && inProgressEpisodes.length === 0);

  return (
    <>
      {!showSidebarControls && (
        <SEO
          title="Your Library - Syra"
          description="Your music library"
        />
      )}
      <View style={styles.libraryContainer}>
      <Animated.ScrollView
        style={styles.container}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
      >
        <View style={styles.header}>
          <Text style={[styles.title, { color: theme.colors.text }]}>Your Library</Text>
          <View style={styles.headerActions}>
            {showSidebarControls && onFullscreen && (
              <Pressable
                onPress={onFullscreen}
                style={[styles.headerButton, { backgroundColor: theme.colors.backgroundTertiary }]}
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
                style={[styles.headerButton, { backgroundColor: theme.colors.backgroundTertiary }]}
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
        <View style={styles.filters}>
          {LIBRARY_FILTERS.map((filter) => {
            const isActive = activeFilter === filter;
            return (
              <Pressable
                key={filter}
                onPress={() => setActiveFilter(filter)}
                style={[
                  styles.filterButton,
                  {
                    backgroundColor: isActive ? theme.colors.primary : theme.colors.backgroundTertiary
                  }
                ]}
              >
                <Text style={[
                  styles.filterText, 
                  { 
                    color: isActive ? theme.colors.primaryForeground : theme.colors.text,
                    fontWeight: isActive ? '700' : '600'
                  }
                ]}>
                  {filter}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Liked Songs - show only when All or Playlists filter is active */}
        {gate.isAuthenticated && (activeFilter === 'All' || activeFilter === 'Playlists') && (
          <Pressable
            style={[styles.libraryItem, { backgroundColor: theme.colors.backgroundTertiary }]}
            onPress={() => router.push('/library/liked')}
          >
            <View style={[styles.likedIcon, { backgroundColor: theme.colors.primary }]}>
              <Ionicons name="heart" size={24} color={theme.colors.primaryForeground} />
            </View>
            <View style={styles.itemContent}>
              <Text style={[styles.itemTitle, { color: theme.colors.text }]}>Liked Songs</Text>
              <Text style={[styles.itemSubtitle, { color: theme.colors.textSecondary }]}>
                Playlist • {finalLoading ? '...' : `${finalLikedTracksCount} ${finalLikedTracksCount === 1 ? 'song' : 'songs'}`}
              </Text>
            </View>
          </Pressable>
        )}

        {/* Loading state */}
        {finalLoading && (gate.isAuthenticated || gate.isResolving) && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Playlists</Text>
            <View style={styles.itemsContainer}>
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
              title: 'Could not load your library',
              message: finalError,
              onRetry: collections.retry,
            }}
          />
        )}

        {/* Playlists list */}
        {!finalLoading && !finalError && finalPlaylists.length > 0 && (activeFilter === 'All' || activeFilter === 'Playlists') && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Playlists</Text>
            <View style={styles.itemsContainer}>
              {finalPlaylists.map((playlist) => (
                <Pressable
                  key={playlist.id}
                  style={[styles.libraryItem, { backgroundColor: theme.colors.backgroundTertiary }]}
                  onPress={() => router.push(`/playlist/${playlist.id}`)}
                >
                  {playlist.coverArt ? (
                    <Image
                      source={{ uri: pickCatalogImageUrl(undefined, playlist.coverArt, 'thumbnail', playlist.coverArtSizes) }}
                      style={styles.playlistImage}
                      contentFit="cover"
                    />
                  ) : (
                    <View style={[styles.playlistImagePlaceholder, { backgroundColor: theme.colors.background }]}>
                      <MaterialCommunityIcons
                        name="playlist-music"
                        size={24}
                        color={theme.colors.textSecondary}
                      />
                    </View>
                  )}
                  <View style={styles.itemContent}>
                    <Text style={[styles.itemTitle, { color: theme.colors.text }]} numberOfLines={1}>
                      {playlist.name}
                    </Text>
                    <Text style={[styles.itemSubtitle, { color: theme.colors.textSecondary }]}>
                      {playlist.visibility === 'public' ? 'Public' : 'Private'} • {playlist.trackCount || 0} {playlist.trackCount === 1 ? 'song' : 'songs'}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* Artists list */}
        {!finalLoading && !finalError && finalFollowedArtists.length > 0 && (activeFilter === 'All' || activeFilter === 'Artists') && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Artists</Text>
            <View style={styles.itemsContainer}>
              {finalFollowedArtists.map((artist) => (
                <Pressable
                  key={artist.id}
                  style={[styles.libraryItem, { backgroundColor: theme.colors.backgroundTertiary }]}
                  onPress={() => router.push(`/p/${artist.id}`)}
                >
                  {(artist.image || artist.images?.length) ? (
                    <Image
                      source={{ uri: pickCatalogImageUrl(artist.images, artist.image, 'thumbnail', artist.imageSizes) }}
                      style={styles.artistImage}
                      contentFit="cover"
                    />
                  ) : (
                    <View style={[styles.artistImagePlaceholder, { backgroundColor: theme.colors.background }]}>
                      <Ionicons
                        name="person"
                        size={24}
                        color={theme.colors.textSecondary}
                      />
                    </View>
                  )}
                  <View style={styles.itemContent}>
                    <Text style={[styles.itemTitle, { color: theme.colors.text }]} numberOfLines={1}>
                      {artist.name}
                    </Text>
                    <Text style={[styles.itemSubtitle, { color: theme.colors.textSecondary }]}>
                      Artist
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* Albums list */}
        {!finalLoading && !finalError && finalSavedAlbums.length > 0 && (activeFilter === 'All' || activeFilter === 'Albums') && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Albums</Text>
            <View style={styles.itemsContainer}>
              {finalSavedAlbums.map((album) => (
                <Pressable
                  key={album.id}
                  style={[styles.libraryItem, { backgroundColor: theme.colors.backgroundTertiary }]}
                  onPress={() => router.push(`/album/${album.id}`)}
                >
                  {album.coverArt ? (
                    <Image
                      source={{ uri: pickCatalogImageUrl(undefined, album.coverArt, 'thumbnail', album.coverArtSizes) }}
                      style={styles.playlistImage}
                      contentFit="cover"
                    />
                  ) : (
                    <View style={[styles.playlistImagePlaceholder, { backgroundColor: theme.colors.background }]}>
                      <MaterialCommunityIcons
                        name="album"
                        size={24}
                        color={theme.colors.textSecondary}
                      />
                    </View>
                  )}
                  <View style={styles.itemContent}>
                    <Text style={[styles.itemTitle, { color: theme.colors.text }]} numberOfLines={1}>
                      {album.title}
                    </Text>
                    <Text style={[styles.itemSubtitle, { color: theme.colors.textSecondary }]}>
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
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Podcasts</Text>
            <View style={styles.itemsContainer}>
              {subscribedPodcasts.map(({ podcast }) => {
                const imageUri = resolvePodcastArtwork(podcast, 'thumbnail');
                return (
                  <Pressable
                    key={podcast.id}
                    style={[styles.libraryItem, { backgroundColor: theme.colors.backgroundTertiary }]}
                    onPress={() => router.push({ pathname: '/podcasts/[id]', params: { id: podcast.id } })}
                  >
                    {imageUri ? (
                      <Image source={{ uri: imageUri }} style={styles.playlistImage} contentFit="cover" />
                    ) : (
                      <View style={[styles.playlistImagePlaceholder, { backgroundColor: theme.colors.background }]}>
                        <MaterialCommunityIcons name="podcast" size={24} color={theme.colors.textSecondary} />
                      </View>
                    )}
                    <View style={styles.itemContent}>
                      <Text style={[styles.itemTitle, { color: theme.colors.text }]} numberOfLines={1}>
                        {podcast.title}
                      </Text>
                      <Text style={[styles.itemSubtitle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                        {podcast.author ?? 'Podcast'}
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
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Continue listening</Text>
            <View style={styles.itemsContainer}>
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
            title={EMPTY_LIBRARY_TEXT[activeFilter]}
            action={
              activeFilter === 'Playlists'
                ? { label: 'Create your first playlist', onPress: () => router.push('/create-playlist') }
                : undefined
            }
          />
        )}

        {/* Signed out — a terminal state, distinct from a session still resolving */}
        {gate.status === 'guest' && !finalLoading && (
          <EmptyState
            containerStyle={styles.inlineState}
            icon={{ name: 'lock-closed-outline' }}
            title="Sign in to view your library"
          />
        )}
      </Animated.ScrollView>

        {gate.canUsePrivateApi && (
          <Fab
            onPress={() => router.push('/create-playlist')}
            iconName="plus"
            accessibilityLabel={t('Create Playlist')}
            label={t('Create Playlist')}
            expanded={fabExpanded}
            size={showSidebarControls ? 48 : 56}
            style={fabStyle}
          />
        )}
      </View>
    </>
  );
};

const styles = StyleSheet.create({
  libraryContainer: {
    flex: 1,
    position: 'relative',
  },
  container: {
    flex: 1,
  },
  fab: {
    position: 'absolute',
  },
  contentContainer: {
    padding: 12,
    paddingBottom: 100,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  headerButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  filters: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 12,
    alignItems: 'center',
  },
  filterButton: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  filterText: {
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 13,
  },
  libraryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 8,
    borderRadius: 6,
    marginBottom: 8,
  },
  likedIcon: {
    width: 48,
    height: 48,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemContent: {
    flex: 1,
  },
  itemTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  itemSubtitle: {
    fontSize: 12,
  },
  // States rendered INSIDE the scroll view: no `flex: 1` stretch and no opaque
  // background of their own, so they sit inline under the filter row.
  inlineState: {
    flex: 0,
    paddingVertical: 32,
    backgroundColor: 'transparent',
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  itemsContainer: {
    gap: 0,
  },
  playlistImage: {
    width: 48,
    height: 48,
    borderRadius: 4,
  },
  playlistImagePlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artistImage: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  artistImagePlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default LibraryScreen;
