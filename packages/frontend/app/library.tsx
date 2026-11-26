import React, { useState, useMemo } from 'react';
import { Platform, StyleSheet, View, Text, Pressable, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@oxy.so/bloom/theme';
import SEO from '@/components/SEO';
import { LibraryListSkeleton } from '@/components/skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Fab } from '@/components/ui/Fab';
import { useAuthGate } from '@/hooks/useAuthGate';
import { useCollapseOnScroll } from '@/hooks/useCollapseOnScroll';
import { useLibraryCollections } from '@/hooks/useLibraryCollections';
import { PLAYER_BAR_HEIGHT } from '@/constants/layout';
import Ionicons from '@expo/vector-icons/Ionicons';
import Octicons from '@expo/vector-icons/Octicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter } from 'expo-router';
import { Playlist, Album, Artist } from '@syra/shared-types';
import { Image } from 'expo-image';
import { pickCatalogImageUrl, resolvePodcastArtwork } from '@/utils/pickImage';
import { ownedShowStateKey } from '@/utils/podcastFormat';
import { EpisodeRow } from '@/components/EpisodeRow';
import { useSubscriptions, useContinueListening, useMyPodcasts } from '@/hooks/usePodcasts';
import { useUploads } from '@/hooks/useUploads';
import { usePlayerStore } from '@/stores/playerStore';
import { createTokenStyles } from '@oxy.so/bloom/theme';

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
const LIBRARY_FILTERS = [
  'All',
  'Playlists',
  'Artists',
  'Albums',
  'Uploads',
  'Podcasts',
  'Shows',
  'Episodes',
] as const;
type LibraryFilter = (typeof LIBRARY_FILTERS)[number];

/** Chip label per filter. */
const LIBRARY_FILTER_KEYS: Record<LibraryFilter, string> = {
  All: 'common.all',
  Playlists: 'common.playlists',
  Artists: 'common.artists',
  Albums: 'common.albums',
  Uploads: 'uploads.locker.title',
  Podcasts: 'common.podcasts',
  Shows: 'library.yourShows',
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
  Shows: 'library.empty.shows',
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
  const themed = useThemedStyles();
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
    [insets.bottom],
  );

  // Filter state
  const [activeFilter, setActiveFilter] = useState<LibraryFilter>('All');

  // Podcasts vertical: subscribed shows, the viewer's OWN shows, and in-progress
  // episodes. Subscribed and owned are separate lists rather than one, because
  // they are separate relationships — a subscription is a saved id that drops out
  // when the show stops being readable, ownership is a property of the show row
  // that only the platform can take away, and the server serializes them
  // differently in the same response (an owned show carries its feed URL and its
  // true episode count, including episodes nobody else can see).
  const subscriptionsQuery = useSubscriptions();
  const myPodcastsQuery = useMyPodcasts();
  const continueQuery = useContinueListening();
  const subscribedPodcasts = subscriptionsQuery.data?.subscriptions ?? [];
  const myPodcasts = myPodcastsQuery.data ?? [];
  const inProgressEpisodes = (continueQuery.data ?? []).filter((entry) => !entry.completed);
  // The listener's own uploads. Private by construction — a separate collection
  // no catalogue query reads — so they get their own entry rather than being
  // mixed into saved albums or playlists.
  const uploadsQuery = useUploads();
  const { uploads, total: uploadCount } = uploadsQuery;
  const currentEpisode = usePlayerStore((s) => s.currentEpisode);
  const isEpisodePlaying = usePlayerStore((s) => s.isPlaying);
  const playEpisode = usePlayerStore((s) => s.playEpisode);

  // Use props if provided (sidebar mode), otherwise fetch via the shared
  // React Query library layer (standalone mode). The collections derive from
  // the `['library']` membership cache, so optimistic like/save/follow toggles
  // anywhere in the app keep these counts and lists in sync.
  const isUsingProps = propsPlaylists !== undefined;
  const collections = useLibraryCollections();

  const finalPlaylists = isUsingProps ? propsPlaylists || [] : collections.playlists;
  const finalSavedAlbums = isUsingProps ? propsSavedAlbums || [] : collections.savedAlbums;
  const finalFollowedArtists = isUsingProps
    ? propsFollowedArtists || []
    : collections.followedArtists;
  const finalLikedTracksCount = isUsingProps
    ? propsLikedTracksCount || 0
    : collections.likedTracksCount;
  const finalLoading =
    gate.isResolving || (isUsingProps ? (propsLoading ?? false) : collections.loading);
  // A session that never resolved is an error in BOTH modes — in sidebar mode
  // the parent passes data but not the session's terminal state, so an
  // unresolved auth would otherwise fall through to "your library is empty".
  const finalError = gate.isTimedOut
    ? t('library.errors.session')
    : isUsingProps
      ? (propsError ?? null)
      : collections.error;

  // Each of the four sections above renders straight off `?? []`, which collapses
  // three different situations into one empty array: the query succeeded and
  // returned nothing, the query is still in flight, and the query REJECTED. The
  // last one is the failure this screen shipped with — `getMyPodcasts()` throws on
  // a 401 or on a single drifted DTO field, so a creator whose shows exist was
  // told, in the empty state's own words, that they had never made one. A section
  // that has not settled successfully knows nothing about whether it is empty, so
  // it says so instead: its own error affordance with its own retry, and no vote
  // in the "your library is empty" verdict below.
  const subscriptionsUnresolved = subscriptionsQuery.isError || subscriptionsQuery.isPending;
  const myPodcastsUnresolved = myPodcastsQuery.isError || myPodcastsQuery.isPending;
  const inProgressUnresolved = continueQuery.isError || continueQuery.isPending;
  const uploadsUnresolved = uploadsQuery.isError || uploadsQuery.isLoading;

  const isLibraryEmptyForFilter =
    (activeFilter === 'All' &&
      finalPlaylists.length === 0 &&
      finalFollowedArtists.length === 0 &&
      finalSavedAlbums.length === 0 &&
      !subscriptionsUnresolved &&
      subscribedPodcasts.length === 0 &&
      !myPodcastsUnresolved &&
      myPodcasts.length === 0 &&
      !inProgressUnresolved &&
      inProgressEpisodes.length === 0 &&
      !uploadsUnresolved &&
      uploads.length === 0) ||
    (activeFilter === 'Playlists' && finalPlaylists.length === 0) ||
    (activeFilter === 'Artists' && finalFollowedArtists.length === 0) ||
    (activeFilter === 'Albums' && finalSavedAlbums.length === 0) ||
    (activeFilter === 'Uploads' && !uploadsUnresolved && uploads.length === 0) ||
    (activeFilter === 'Podcasts' && !subscriptionsUnresolved && subscribedPodcasts.length === 0) ||
    (activeFilter === 'Shows' && !myPodcastsUnresolved && myPodcasts.length === 0) ||
    (activeFilter === 'Episodes' && !inProgressUnresolved && inProgressEpisodes.length === 0);

  return (
    <>
      {!showSidebarControls && (
        <SEO title={t('library.seo.title')} description={t('library.seo.description')} />
      )}
      <View style={styles.container}>
        <Animated.ScrollView
          style={styles.fill}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          onScroll={scrollHandler}
          scrollEventThrottle={16}
        >
          <View style={styles.row}>
            <Text style={themed.title}>{t('library.title')}</Text>
            <View style={styles.row2}>
              {showSidebarControls && onFullscreen && (
                <Pressable onPress={onFullscreen} style={[themed.popover, styles.controlButton]}>
                  <Ionicons
                    name={isFullscreen ? 'contract' : 'expand'}
                    size={18}
                    color={theme.colors.text}
                  />
                </Pressable>
              )}
              {showSidebarControls && onCollapse && !isFullscreen && (
                <Pressable onPress={onCollapse} style={[themed.popover, styles.controlButton]}>
                  <Octicons name="sidebar-collapse" size={18} color={theme.colors.text} />
                </Pressable>
              )}
            </View>
          </View>

          <View style={styles.row3}>
            <Pressable
              accessibilityRole="link"
              onPress={() => router.push('/library/history')}
              style={themed.surface}
            >
              <Text style={themed.text}>{t('listener.history')}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="link"
              onPress={() => router.push('/library/queue')}
              style={themed.surface}
            >
              <Text style={themed.text}>{t('listener.queue')}</Text>
            </Pressable>
          </View>
          {/* Filters */}
          <View style={styles.row4}>
            {LIBRARY_FILTERS.map((filter) => {
              const isActive = activeFilter === filter;
              return (
                <Pressable
                  key={filter}
                  onPress={() => setActiveFilter(filter)}
                  style={[isActive ? themed.activeChip : themed.popover, styles.filterChip]}
                >
                  <Text
                    style={[
                      styles.filterLabel,
                      isActive ? themed.activeFilterLabel : themed.filterLabel,
                    ]}
                  >
                    {t(LIBRARY_FILTER_KEYS[filter])}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Liked Songs - show only when All or Playlists filter is active */}
          {gate.isAuthenticated && (activeFilter === 'All' || activeFilter === 'Playlists') && (
            <Pressable style={themed.row5} onPress={() => router.push('/library/liked')}>
              <View style={themed.centered}>
                <Ionicons name="heart" size={24} color={theme.colors.primaryForeground} />
              </View>
              <View style={styles.fill}>
                <Text style={themed.title2}>{t('library.likedSongs')}</Text>
                <Text style={themed.mutedText}>
                  Playlist •{' '}
                  {finalLoading
                    ? '...'
                    : `${finalLikedTracksCount} ${finalLikedTracksCount === 1 ? 'song' : 'songs'}`}
                </Text>
              </View>
            </Pressable>
          )}

          {/* Your uploads — the private locker, alongside Liked Songs rather than
            inside the saved-album lists, because nothing in it is catalogue. */}
          {gate.isAuthenticated &&
            (activeFilter === 'All' || activeFilter === 'Uploads') &&
            uploads.length > 0 && (
              <Pressable style={themed.row5} onPress={() => router.push('/library/uploads')}>
                <View style={themed.centered2}>
                  <MaterialCommunityIcons name="folder-music" size={24} color={theme.colors.text} />
                </View>
                <View style={styles.fill}>
                  <Text style={themed.title2}>{t('uploads.locker.title')}</Text>
                  <Text style={themed.mutedText}>
                    {t('uploads.locker.trackCount', { count: uploadCount })}
                  </Text>
                </View>
              </Pressable>
            )}

          {/* …and the locker's own failure, in its place. The same `EmptyState`
            error shape as the collections error above, but scoped to one
            section and retrying one query, because a failed locker says nothing
            about whether the sections below it loaded. */}
          {gate.isAuthenticated &&
            (activeFilter === 'All' || activeFilter === 'Uploads') &&
            uploadsQuery.isError && (
              <EmptyState
                containerStyle={styles.inlineState}
                icon={{ name: 'cloud-offline-outline' }}
                error={{
                  title: t('uploads.locker.loadError'),
                  message: t('common.retryHint'),
                  onRetry: async () => {
                    await uploadsQuery.refetch();
                  },
                }}
              />
            )}

          {/* Loading state */}
          {finalLoading && (gate.isAuthenticated || gate.isResolving) && (
            <View style={styles.section}>
              <Text style={themed.title3}>{t('common.playlists')}</Text>
              <View style={styles.stack}>
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
          {!finalLoading &&
            !finalError &&
            finalPlaylists.length > 0 &&
            (activeFilter === 'All' || activeFilter === 'Playlists') && (
              <View style={styles.section}>
                <Text style={themed.title3}>{t('common.playlists')}</Text>
                <View style={styles.stack}>
                  {finalPlaylists.map((playlist) => (
                    <Pressable
                      key={playlist.id}
                      style={themed.row5}
                      onPress={() => router.push(`/playlist/${playlist.id}`)}
                    >
                      {playlist.coverArt ? (
                        <Image
                          source={{
                            uri: pickCatalogImageUrl(
                              undefined,
                              playlist.coverArt,
                              'thumbnail',
                              playlist.coverArtSizes,
                            ),
                          }}
                          style={styles.squareArtwork}
                          contentFit="cover"
                        />
                      ) : (
                        <View style={themed.centered3}>
                          <MaterialCommunityIcons
                            name="playlist-music"
                            size={24}
                            color={theme.colors.textSecondary}
                          />
                        </View>
                      )}
                      <View style={styles.fill}>
                        <Text style={themed.title2} numberOfLines={1}>
                          {playlist.name}
                        </Text>
                        <Text style={themed.mutedText}>
                          {playlist.visibility === 'public'
                            ? t('common.public')
                            : t('common.private')}{' '}
                          • {t('common.songCount', { count: playlist.trackCount || 0 })}
                        </Text>
                      </View>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}

          {/* Artists list */}
          {!finalLoading &&
            !finalError &&
            finalFollowedArtists.length > 0 &&
            (activeFilter === 'All' || activeFilter === 'Artists') && (
              <View style={styles.section}>
                <Text style={themed.title3}>{t('common.artists')}</Text>
                <View style={styles.stack}>
                  {finalFollowedArtists.map((artist) => (
                    <Pressable
                      key={artist.id}
                      style={themed.row5}
                      onPress={() => router.push(`/p/${artist.id}`)}
                    >
                      {artist.image || artist.images?.length ? (
                        <Image
                          source={{
                            uri: pickCatalogImageUrl(
                              artist.images,
                              artist.image,
                              'thumbnail',
                              artist.imageSizes,
                            ),
                          }}
                          style={styles.roundArtwork}
                          contentFit="cover"
                        />
                      ) : (
                        <View style={themed.centered4}>
                          <Ionicons name="person" size={24} color={theme.colors.textSecondary} />
                        </View>
                      )}
                      <View style={styles.fill}>
                        <Text style={themed.title2} numberOfLines={1}>
                          {artist.name}
                        </Text>
                        <Text style={themed.mutedText}>{t('common.artist')}</Text>
                      </View>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}

          {/* Albums list */}
          {!finalLoading &&
            !finalError &&
            finalSavedAlbums.length > 0 &&
            (activeFilter === 'All' || activeFilter === 'Albums') && (
              <View style={styles.section}>
                <Text style={themed.title3}>{t('common.albums')}</Text>
                <View style={styles.stack}>
                  {finalSavedAlbums.map((album) => (
                    <Pressable
                      key={album.id}
                      style={themed.row5}
                      onPress={() => router.push(`/album/${album.id}`)}
                    >
                      {album.coverArt ? (
                        <Image
                          source={{
                            uri: pickCatalogImageUrl(
                              undefined,
                              album.coverArt,
                              'thumbnail',
                              album.coverArtSizes,
                            ),
                          }}
                          style={styles.squareArtwork}
                          contentFit="cover"
                        />
                      ) : (
                        <View style={themed.centered3}>
                          <MaterialCommunityIcons
                            name="album"
                            size={24}
                            color={theme.colors.textSecondary}
                          />
                        </View>
                      )}
                      <View style={styles.fill}>
                        <Text style={themed.title2} numberOfLines={1}>
                          {album.title}
                        </Text>
                        <Text style={themed.mutedText}>
                          {album.artistName} •{' '}
                          {album.releaseDate ? new Date(album.releaseDate).getFullYear() : ''}
                        </Text>
                      </View>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}

          {/* Subscribed podcasts */}
          {gate.isAuthenticated &&
            (activeFilter === 'All' || activeFilter === 'Podcasts') &&
            subscribedPodcasts.length > 0 && (
              <View style={styles.section}>
                <Text style={themed.title3}>{t('common.podcasts')}</Text>
                <View style={styles.stack}>
                  {subscribedPodcasts.map(({ podcast }) => {
                    const imageUri = resolvePodcastArtwork(podcast, 'thumbnail');
                    return (
                      <Pressable
                        key={podcast.id}
                        style={themed.row5}
                        onPress={() =>
                          router.push({ pathname: '/podcasts/[id]', params: { id: podcast.id } })
                        }
                      >
                        {imageUri ? (
                          <Image
                            source={{ uri: imageUri }}
                            style={styles.squareArtwork}
                            contentFit="cover"
                          />
                        ) : (
                          <View style={themed.centered3}>
                            <MaterialCommunityIcons
                              name="podcast"
                              size={24}
                              color={theme.colors.textSecondary}
                            />
                          </View>
                        )}
                        <View style={styles.fill}>
                          <Text style={themed.title2} numberOfLines={1}>
                            {podcast.title}
                          </Text>
                          <Text style={themed.mutedText} numberOfLines={1}>
                            {podcast.author ?? t('common.podcast')}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}

          {/* …and the subscriptions' own failure, in their place. */}
          {gate.isAuthenticated &&
            (activeFilter === 'All' || activeFilter === 'Podcasts') &&
            subscriptionsQuery.isError && (
              <EmptyState
                containerStyle={styles.inlineState}
                icon={{ name: 'cloud-offline-outline' }}
                error={{
                  title: t('library.errors.podcasts'),
                  message: t('common.retryHint'),
                  onRetry: async () => {
                    await subscriptionsQuery.refetch();
                  },
                }}
              />
            )}

          {/* The viewer's OWN shows.
            Its own section rather than a row mixed into the subscriptions above,
            for the reason the uploads locker gets its own entry: what you MADE
            and what you FOLLOW are different relationships, and here they are
            visibly different rows too — an owned show reports its STATE, because
            `GET /api/podcasts/mine` is deliberately unfiltered and this is the
            surface a creator would otherwise conclude from that their private or
            unpublished show is live. A show you own and also subscribe to
            appears in both lists, which is true rather than a duplicate. */}
          {gate.isAuthenticated &&
            (activeFilter === 'All' || activeFilter === 'Shows') &&
            myPodcasts.length > 0 && (
              <View style={styles.section}>
                <Text style={themed.title3}>{t('library.yourShows')}</Text>
                <View style={styles.stack}>
                  {myPodcasts.map((podcast) => {
                    const imageUri = resolvePodcastArtwork(podcast, 'thumbnail');
                    return (
                      <Pressable
                        key={podcast.id}
                        style={themed.row5}
                        onPress={() =>
                          router.push({ pathname: '/podcasts/[id]', params: { id: podcast.id } })
                        }
                      >
                        {imageUri ? (
                          <Image
                            source={{ uri: imageUri }}
                            style={styles.squareArtwork}
                            contentFit="cover"
                          />
                        ) : (
                          <View style={themed.centered3}>
                            <MaterialCommunityIcons
                              name="podcast"
                              size={24}
                              color={theme.colors.textSecondary}
                            />
                          </View>
                        )}
                        <View style={styles.fill}>
                          <Text style={themed.title2} numberOfLines={1}>
                            {podcast.title}
                          </Text>
                          <Text style={themed.mutedText} numberOfLines={1}>
                            {t(ownedShowStateKey(podcast))}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}

          {/* …and the same section when the query REJECTED — which is what the
            reported "I can't see my podcasts" was: the rows, the API and the
            deployed bundle were all correct, and a thrown parse removed the
            section with nothing said in its place. */}
          {gate.isAuthenticated &&
            (activeFilter === 'All' || activeFilter === 'Shows') &&
            myPodcastsQuery.isError && (
              <EmptyState
                containerStyle={styles.inlineState}
                icon={{ name: 'cloud-offline-outline' }}
                error={{
                  title: t('library.errors.shows'),
                  message: t('common.retryHint'),
                  onRetry: async () => {
                    await myPodcastsQuery.refetch();
                  },
                }}
              />
            )}

          {/* In-progress episodes */}
          {gate.isAuthenticated &&
            (activeFilter === 'All' || activeFilter === 'Episodes') &&
            inProgressEpisodes.length > 0 && (
              <View style={styles.section}>
                <Text style={themed.title3}>{t('library.continueListening')}</Text>
                <View style={styles.stack}>
                  {inProgressEpisodes.map((entry) => (
                    <EpisodeRow
                      key={entry.episode.id}
                      episode={entry.episode}
                      progress={{
                        progressSec: entry.progressSec,
                        durationSec: entry.durationSec,
                        completed: entry.completed,
                      }}
                      isCurrent={currentEpisode?.id === entry.episode.id}
                      isPlaying={currentEpisode?.id === entry.episode.id && isEpisodePlaying}
                      onPress={() =>
                        router.push({ pathname: '/episode/[id]', params: { id: entry.episode.id } })
                      }
                      onPlayPress={() =>
                        playEpisode(entry.episode, { resumeFromSec: entry.progressSec })
                      }
                    />
                  ))}
                </View>
              </View>
            )}

          {/* …and the in-progress episodes' own failure, in their place. */}
          {gate.isAuthenticated &&
            (activeFilter === 'All' || activeFilter === 'Episodes') &&
            continueQuery.isError && (
              <EmptyState
                containerStyle={styles.inlineState}
                icon={{ name: 'cloud-offline-outline' }}
                error={{
                  title: t('library.errors.episodes'),
                  message: t('common.retryHint'),
                  onRetry: async () => {
                    await continueQuery.refetch();
                  },
                }}
              />
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
                  ? {
                      label: t('library.createFirstPlaylist'),
                      onPress: () => router.push('/create-playlist'),
                    }
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

  container: { position: 'relative', flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  content: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 100 },
  row: {
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  row2: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  row3: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  row4: { marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
  section: { marginBottom: 24 },
  stack: { gap: 0 },
  controlButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    ...Platform.select({ web: { cursor: 'pointer' as const } }),
  },
  filterChip: {
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  filterLabel: { fontSize: 11, lineHeight: 13 },
});

export default LibraryScreen;

const useThemedStyles = createTokenStyles((t) => ({
  popover: { backgroundColor: t.popover },
  activeChip: { backgroundColor: t.primary },
  activeFilterLabel: { fontWeight: 700, color: t.primaryForeground },
  filterLabel: { fontWeight: 600, color: t.foreground },
  title: { fontSize: 24, fontWeight: 700, color: t.foreground },
  surface: {
    borderRadius: 9999,
    backgroundColor: t.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  text: { color: t.foreground },
  row5: {
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 6,
    backgroundColor: t.popover,
    padding: 8,
  },
  centered: {
    height: 48,
    width: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    backgroundColor: t.primary,
  },
  title2: { marginBottom: 2, fontSize: 14, fontWeight: 600, color: t.foreground },
  mutedText: { fontSize: 12, color: t.mutedForeground },
  centered2: {
    height: 48,
    width: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    backgroundColor: t.surface,
  },
  title3: { marginBottom: 12, fontSize: 16, fontWeight: 700, color: t.foreground },
  centered3: {
    height: 48,
    width: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    backgroundColor: t.background,
  },
  centered4: {
    height: 48,
    width: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    backgroundColor: t.background,
  },
}));
