import React from 'react';
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
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { toast } from '@/lib/sonner';
import { Track } from '@syra/shared-types';
import { entityService } from '@/services/entityService';
import { usePlayerStore } from '@/stores/playerStore';
import SEO from '@/components/SEO';
import { TrackRow } from '@/components/TrackRow';
import { EpisodeRow } from '@/components/EpisodeRow';
import { MediaCard } from '@/components/MediaCard';
import { ResponsiveGrid } from '@/components/ResponsiveGrid';
import { ArtistDetailSkeleton } from '@/components/skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { pickCatalogImageUrl, resolvePodcastArtwork, type CatalogImageTarget } from '@/utils/pickImage';
import { oxyServices } from '@/lib/oxyServices';
import { useLibrary, useToggleFollowArtist } from '@/hooks/useLibrary';
import { useRelatedArtists } from '@/hooks/useRecommendations';
import { useAuthGate } from '@/hooks/useAuthGate';
import { CATALOG_QUERY_KEYS } from '@/hooks/useLibraryCollections';
import { isNotFoundError } from '@/utils/api';
import { webViewStyle } from '@/utils/webStyles';
import { useViewAmbient } from '@/hooks/useAmbientArtwork';

const HEADER_HEIGHT = 400;

type EntityProfile = NonNullable<Awaited<ReturnType<typeof entityService.getEntityProfile>>>;
type RelatedArtist = NonNullable<ReturnType<typeof useRelatedArtists>['data']>['artists'][number];
type AppearsInEpisode = NonNullable<NonNullable<EntityProfile['appearsIn']>['episodes']>[number];

/**
 * Unified entity profile screen (`/p/[id]`) — a merged music **artist** +
 * podcast **person** page driven by `GET /api/p/:id` (`EntityProfile`). Ports
 * the artist screen (parallax hero, play-all, popular tracks, albums, related
 * artists, follow) for the `music` half, and adds an "Appears in" section for
 * the `appearsIn` (podcasts/episodes) half. A linked entity shows both.
 */
const EntityProfileScreen: React.FC = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const { playTrackList, playEpisode, currentTrack, currentEpisode, isPlaying } = usePlayerStore();
  const gate = useAuthGate();

  const entityQuery = useQuery({
    queryKey: CATALOG_QUERY_KEYS.entity(id, gate.catalogIdentity),
    queryFn: () => entityService.getEntityProfile(id),
    enabled: !!id && gate.isResolved,
  });

  const entity = entityQuery.data ?? null;
  const tracks = entity?.music?.tracks ?? [];
  const isCatalogLoading = gate.isResolving || entityQuery.isLoading;

  // The follow + related-artist features key off the music artist id: the entity
  // id when this is an artist, else its linked artist.
  const artistId = entity
    ? (entity.kind === 'artist' ? entity.id : entity.linkedArtistId)
    : undefined;

  const { isArtistFollowed } = useLibrary();
  const toggleFollow = useToggleFollowArtist();
  const isFollowed = artistId ? isArtistFollowed(artistId) : false;

  const relatedArtistsQuery = useRelatedArtists(artistId);
  const relatedArtists = relatedArtistsQuery.data?.artists ?? [];

  /**
   * Resolve the entity image at a catalog target size: an artist cover (`image`,
   * a catalog id) via the catalog picker, else an Oxy avatar (`avatar`, a file
   * id) via the Oxy media resolver.
   */
  const entityImage = (target: CatalogImageTarget): string | undefined => {
    if (!entity) return undefined;
    // Prefer the artist cover (catalog id + size variants); fall back to the
    // Oxy avatar (a file id) resolved through the Oxy media resolver.
    if (entity.image || entity.imageSizes) {
      const fromCatalog = pickCatalogImageUrl(undefined, entity.image, target, entity.imageSizes);
      if (fromCatalog) return fromCatalog;
    }
    if (entity.avatar) {
      const variant = target === 'hero' || target === 'detailArtwork' ? 'full' : 'thumb';
      return oxyServices.getFileDownloadUrl(entity.avatar, variant);
    }
    return undefined;
  };

  const displayName = entity ? (entity.displayName || entity.name) : '';

  const heroImage = entityImage('hero');

  // VIEW MODE: theme the WHOLE app from the profile's server-extracted cover
  // colours ON VIEW and restore the default on leave. Called before the early
  // returns so the hook order stays stable; no-ops until the entity loads.
  useViewAmbient(entity?.primaryColor, entity?.secondaryColor);

  const handlePlayAll = () => {
    if (tracks.length === 0) {
      toast.info('No playable tracks available');
      return;
    }
    playTrackList(tracks, 0, { type: 'artist', id: artistId, name: displayName });
  };

  const handleTrackPress = (track: Track) => {
    const index = Math.max(0, tracks.findIndex((item) => item.id === track.id));
    playTrackList(tracks, index, { type: 'artist', id: artistId, name: displayName });
  };

  const handleFollow = () => {
    if (!gate.isAuthenticated) {
      toast.error('You must be logged in to follow artists');
      return;
    }
    if (!artistId) {
      return;
    }
    const next = !isFollowed;
    toggleFollow.mutate(
      { id: artistId, next },
      {
        onSuccess: () => {
          toast.success(next ? `Following ${displayName}` : `Unfollowed ${displayName}`);
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : 'Failed to update follow status');
        },
      },
    );
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
          <ArtistDetailSkeleton />
        </ScrollView>
      </View>
    );
  }

  // A failed request is not a missing profile: only a 404 falls through to the
  // "not found" branch below, everything else is a load failure with a retry.
  if (entityQuery.isError && !isNotFoundError(entityQuery.error)) {
    return (
      <EmptyState
        containerStyle={{ backgroundColor: theme.colors.backgroundSecondary }}
        icon={{ name: 'cloud-offline-outline' }}
        error={{
          title: 'Could not load this profile',
          message: 'Something went wrong while loading this profile. Please try again.',
          onRetry: async () => {
            await entityQuery.refetch();
          },
        }}
      />
    );
  }

  if (!entity) {
    return (
      <EmptyState
        containerStyle={{ backgroundColor: theme.colors.backgroundSecondary }}
        icon={{ name: 'person-outline' }}
        title="Profile not found"
        subtitle="This profile may have been removed or is no longer available."
      />
    );
  }

  // The whole app is themed from this profile's hero cover ON VIEW (see
  // `useViewAmbient` above). No per-screen theme wrapper and no cover-hover
  // theming — `EntityProfileView` reads the already-themed app theme.
  return (
    <EntityProfileView
      entity={entity}
      displayName={displayName}
      artistId={artistId}
      isFollowed={isFollowed}
      followPending={toggleFollow.isPending}
      relatedArtists={relatedArtists}
      relatedArtistsPending={relatedArtistsQuery.isPending}
      heroImage={heroImage}
      smallImage={entityImage('smallArtwork')}
      iconImage={entityImage('icon')}
      currentTrackId={currentTrack?.id}
      currentEpisodeId={currentEpisode?.id}
      isPlaying={isPlaying}
      onPlayAll={handlePlayAll}
      onTrackPress={handleTrackPress}
      onFollow={handleFollow}
      onPlayEpisode={playEpisode}
      onNavigateArtist={(artist) => router.push({ pathname: '/p/[id]', params: { id: artist } })}
      onNavigateAlbum={(album) => router.push(`/album/${album}`)}
      onNavigatePodcast={(podcast) => router.push({ pathname: '/podcasts/[id]', params: { id: podcast } })}
      onNavigateEpisode={(episode) => router.push({ pathname: '/episode/[id]', params: { id: episode } })}
    />
  );
};

interface EntityProfileViewProps {
  entity: EntityProfile;
  displayName: string;
  artistId: string | undefined;
  isFollowed: boolean;
  followPending: boolean;
  relatedArtists: RelatedArtist[];
  relatedArtistsPending: boolean;
  heroImage: string | undefined;
  smallImage: string | undefined;
  iconImage: string | undefined;
  currentTrackId: string | undefined;
  currentEpisodeId: string | undefined;
  isPlaying: boolean;
  onPlayAll: () => void;
  onTrackPress: (track: Track) => void;
  onFollow: () => void;
  onPlayEpisode: (episode: AppearsInEpisode) => void;
  onNavigateArtist: (artistId: string) => void;
  onNavigateAlbum: (albumId: string) => void;
  onNavigatePodcast: (podcastId: string) => void;
  onNavigateEpisode: (episodeId: string) => void;
}

/**
 * The profile's presentational view. Reads the app theme via `useTheme()`; the
 * app is already themed from the hero cover on view (see `useViewAmbient` in
 * `EntityProfileScreen`), so the hero + sections reflect the artwork palette with
 * no cover-hover handling here. Owns the parallax scroll hooks.
 */
const EntityProfileView: React.FC<EntityProfileViewProps> = ({
  entity,
  displayName,
  artistId,
  isFollowed,
  followPending,
  relatedArtists,
  relatedArtistsPending,
  heroImage,
  smallImage,
  iconImage,
  currentTrackId,
  currentEpisodeId,
  isPlaying,
  onPlayAll,
  onTrackPress,
  onFollow,
  onPlayEpisode,
  onNavigateArtist,
  onNavigateAlbum,
  onNavigatePodcast,
  onNavigateEpisode,
}) => {
  const theme = useTheme();
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollOffset = useScrollViewOffset(scrollRef);

  const tracks = entity.music?.tracks ?? [];
  const albums = entity.music?.albums ?? [];
  const podcasts = entity.appearsIn?.podcasts ?? [];
  const episodes = entity.appearsIn?.episodes ?? [];
  const canPlay = tracks.length > 0;

  const headerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: interpolate(
          scrollOffset.value,
          [-HEADER_HEIGHT, 0, HEADER_HEIGHT],
          [-HEADER_HEIGHT / 2, 0, HEADER_HEIGHT * 0.75],
        ),
      },
      {
        scale: interpolate(scrollOffset.value, [-HEADER_HEIGHT, 0, HEADER_HEIGHT], [2, 1, 1]),
      },
    ],
  }));

  const headerTitleAnimatedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      scrollOffset.value,
      [0, HEADER_HEIGHT - 100, HEADER_HEIGHT - 50],
      [1, 0.3, 0],
      'clamp',
    ),
  }));

  const stickyHeaderAnimatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(scrollOffset.value, [HEADER_HEIGHT - 100, HEADER_HEIGHT - 50], [0, 1], 'clamp');
    const translateY = interpolate(scrollOffset.value, [HEADER_HEIGHT - 100, HEADER_HEIGHT - 50], [-20, 0], 'clamp');
    return { opacity, transform: [{ translateY }] };
  });

  // Cover-derived hero gradient, same shape as the album/playlist/podcast
  // screens: both colour stops fall back to the neutral secondary background
  // (never the vivid brand accent).
  const gradientColors: readonly [string, string, string] = [
    entity.primaryColor ?? theme.colors.backgroundSecondary,
    entity.secondaryColor ?? theme.colors.backgroundSecondary,
    theme.colors.backgroundSecondary,
  ];

  // Real artist metadata: genres + follower/monthly-listener + album/track counts.
  const metadata = ((): string => {
    const parts: string[] = [];
    const stats = entity.stats;
    if (entity.genres && entity.genres.length > 0) {
      parts.push(entity.genres.join(', '));
    }
    if (stats?.monthlyListeners && stats.monthlyListeners > 0) {
      parts.push(`${stats.monthlyListeners.toLocaleString()} monthly listeners`);
    } else if (stats && stats.followers > 0) {
      parts.push(`${stats.followers.toLocaleString()} ${stats.followers === 1 ? 'follower' : 'followers'}`);
    }
    const albumCount = stats?.albums ?? albums.length;
    const trackCount = stats?.tracks ?? tracks.length;
    if (albumCount > 0) parts.push(`${albumCount} ${albumCount === 1 ? 'album' : 'albums'}`);
    if (trackCount > 0) parts.push(`${trackCount} ${trackCount === 1 ? 'track' : 'tracks'}`);
    if (podcasts.length > 0) parts.push(`${podcasts.length} ${podcasts.length === 1 ? 'show' : 'shows'}`);
    return parts.join('  •  ');
  })();

  return (
    <>
      <SEO title={`${displayName} - Syra`} description={entity.bio || `Listen to ${displayName}`} />
      <View style={[styles.container, { backgroundColor: theme.colors.backgroundSecondary }]}>
        {/* Sticky Header */}
        <Animated.View
          style={[
            styles.stickyHeader,
            { backgroundColor: theme.colors.background, borderBottomColor: theme.colors.backgroundSecondary },
            stickyHeaderAnimatedStyle,
          ]}
          pointerEvents="box-none"
        >
          <View style={styles.stickyHeaderContent}>
            <View style={styles.stickyHeaderCenter}>
              <View style={[styles.stickyHeaderImageContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
                {iconImage ? (
                  <Image source={{ uri: iconImage }} style={styles.stickyHeaderImage} resizeMode="cover" />
                ) : (
                  <Ionicons name="person" size={20} color={theme.colors.textSecondary} />
                )}
              </View>
              <Text style={[styles.stickyHeaderTitle, { color: theme.colors.text }]} numberOfLines={1}>
                {displayName}
              </Text>
              {entity.verified ? (
                <Ionicons name="checkmark-circle" size={16} color={theme.colors.primary} />
              ) : null}
            </View>

            <View style={styles.stickyHeaderControls}>
              {canPlay && (
                <Pressable
                  style={[styles.stickyHeaderPlayButton, { backgroundColor: theme.colors.primary }]}
                  onPress={onPlayAll}
                  accessibilityRole="button"
                >
                  <Ionicons name="play" size={16} color={theme.colors.primaryForeground} />
                </Pressable>
              )}
              {artistId && (
                <Pressable
                  style={styles.stickyHeaderControlButton}
                  onPress={onFollow}
                  disabled={followPending}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isFollowed }}
                  accessibilityLabel={isFollowed ? 'Unfollow artist' : 'Follow artist'}
                >
                  <Ionicons
                    name={isFollowed ? 'heart' : 'heart-outline'}
                    size={20}
                    color={isFollowed ? theme.colors.primary : theme.colors.text}
                  />
                </Pressable>
              )}
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
            {/* Hero cover (the app is themed from it on view, not on hover) */}
            <View
              style={StyleSheet.absoluteFill}
              accessibilityRole="image"
              accessibilityLabel={`${displayName} cover art`}
            >
              {heroImage ? (
                <Image source={{ uri: heroImage }} style={styles.headerImage} resizeMode="cover" />
              ) : (
                <View style={[styles.headerPlaceholder, { backgroundColor: theme.colors.backgroundSecondary }]}>
                  <Ionicons name="person" size={80} color={theme.colors.textSecondary} />
                </View>
              )}
            </View>
            <LinearGradient
              colors={['transparent', 'rgba(0, 0, 0, 0.3)', 'rgba(0, 0, 0, 0.7)'] as readonly [string, string, string]}
              locations={[0, 0.6, 1] as readonly [number, number, number]}
              pointerEvents="none"
              style={styles.headerOverlay}
            />
            <Animated.View pointerEvents="none" style={[styles.titleContainer, headerTitleAnimatedStyle]}>
              <Text style={[styles.artistTitle, { color: '#FFFFFF' }]} numberOfLines={2}>
                {displayName}
              </Text>
            </Animated.View>
          </Animated.View>

          {/* Content Section with Gradient Background */}
          <LinearGradient colors={gradientColors} locations={[0, 0.35, 1]} style={styles.contentSection}>
            {/* Entity Info */}
            <View style={styles.infoContainer}>
              <View style={styles.infoHeader}>
                {smallImage && (
                  <Image source={{ uri: smallImage }} style={styles.infoImage} resizeMode="cover" />
                )}
                <View style={styles.infoTextContainer}>
                  {entity.verified ? (
                    <View style={styles.verifiedRow}>
                      <Ionicons name="checkmark-circle" size={18} color={theme.colors.primary} />
                      <Text style={[styles.verifiedText, { color: theme.colors.text }]}>Verified Artist</Text>
                    </View>
                  ) : null}
                  {entity.bio ? (
                    <Text style={[styles.bio, { color: theme.colors.textSecondary }]} numberOfLines={3}>
                      {entity.bio}
                    </Text>
                  ) : null}
                  {metadata ? (
                    <View style={styles.metadataRow}>
                      <Text style={[styles.metadata, { color: theme.colors.textSecondary }]}>{metadata}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </View>

            {/* Playback Controls (music) */}
            {(canPlay || artistId) && (
              <View style={styles.controlsContainer}>
                {canPlay && (
                  <Pressable
                    style={[styles.playButton, { backgroundColor: theme.colors.primary }]}
                    onPress={onPlayAll}
                    accessibilityRole="button"
                  >
                    <View style={styles.playButtonInner}>
                      <Ionicons name="play" size={24} color={theme.colors.primaryForeground} />
                    </View>
                  </Pressable>
                )}
                {artistId && (
                  <Pressable
                    style={styles.controlButton}
                    onPress={onFollow}
                    disabled={followPending}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isFollowed }}
                    accessibilityLabel={isFollowed ? 'Unfollow artist' : 'Follow artist'}
                  >
                    <Ionicons
                      name={isFollowed ? 'heart' : 'heart-outline'}
                      size={24}
                      color={isFollowed ? theme.colors.primary : theme.colors.text}
                    />
                  </Pressable>
                )}
              </View>
            )}

            {/* Popular Tracks Section */}
            {tracks.length > 0 && (
              <>
                <View style={styles.sectionHeader}>
                  <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Popular</Text>
                </View>
                <View style={styles.trackList}>
                  {tracks.slice(0, 10).map((track, index) => {
                    const isCurrentTrack = currentTrackId === track.id;
                    return (
                      <TrackRow
                        key={track.id}
                        track={track}
                        index={index}
                        isCurrentTrack={isCurrentTrack}
                        isTrackPlaying={isCurrentTrack && isPlaying}
                        onPress={() => onTrackPress(track)}
                        onPlayPress={() => onTrackPress(track)}
                        showNumber
                      />
                    );
                  })}
                </View>
              </>
            )}

            {/* Albums Section */}
            {albums.length > 0 && (
              <>
                <View style={styles.sectionHeader}>
                  <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Albums</Text>
                </View>
                <ResponsiveGrid minItemWidth={180} gap={8} style={styles.albumsGrid}>
                  {albums.map((album) => (
                    <View key={album.id}>
                      <MediaCard
                        title={album.title}
                        subtitle={album.artistName}
                        type="album"
                        imageUri={album.coverArt}
                        imageSizes={album.coverArtSizes}
                        primaryColor={album.primaryColor}
                        onPress={() => onNavigateAlbum(album.id)}
                      />
                    </View>
                  ))}
                </ResponsiveGrid>
              </>
            )}

            {/* Appears in — podcasts the entity hosts/guests in */}
            {podcasts.length > 0 && (
              <>
                <View style={styles.sectionHeader}>
                  <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Appears in</Text>
                </View>
                <ResponsiveGrid minItemWidth={160} gap={8} style={styles.albumsGrid}>
                  {podcasts.map((podcast) => (
                    <View key={podcast.id}>
                      <MediaCard
                        title={podcast.title}
                        subtitle={podcast.author ?? 'Podcast'}
                        type="podcast"
                        resolvedImageUri={resolvePodcastArtwork(podcast, 'card')}
                        primaryColor={podcast.primaryColor}
                        onPress={() => onNavigatePodcast(podcast.id)}
                      />
                    </View>
                  ))}
                </ResponsiveGrid>
              </>
            )}

            {/* Appears in — crediting episodes */}
            {episodes.length > 0 && (
              <>
                <View style={styles.sectionHeader}>
                  <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Episodes</Text>
                </View>
                <View style={styles.trackList}>
                  {episodes.map((episode) => (
                    <EpisodeRow
                      key={episode.id}
                      episode={episode}
                      isCurrent={currentEpisodeId === episode.id}
                      isPlaying={currentEpisodeId === episode.id && isPlaying}
                      onPress={() => onNavigateEpisode(episode.id)}
                      onPlayPress={() => onPlayEpisode(episode)}
                    />
                  ))}
                </View>
              </>
            )}

            {/* Fans also listen to */}
            {relatedArtistsPending ? null : relatedArtists.length > 0 && (
              <>
                <View style={styles.sectionHeader}>
                  <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                    A los fans también les gusta
                  </Text>
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.relatedArtistsRow}>
                  {relatedArtists.map((relatedArtist) => (
                    <View key={relatedArtist.id} style={styles.relatedArtistCard}>
                      <MediaCard
                        title={relatedArtist.name}
                        subtitle="Artist"
                        type="artist"
                        imageUri={relatedArtist.image}
                        images={relatedArtist.images}
                        imageSizes={relatedArtist.imageSizes}
                        primaryColor={relatedArtist.primaryColor}
                        onPress={() => onNavigateArtist(relatedArtist.id)}
                      />
                    </View>
                  ))}
                </ScrollView>
              </>
            )}

            {/* Empty State */}
            {tracks.length === 0 && albums.length === 0 && podcasts.length === 0 && episodes.length === 0 && (
              <View style={styles.emptyState}>
                <Text style={[styles.emptyStateText, { color: theme.colors.textSecondary }]}>
                  Nothing to show yet
                </Text>
              </View>
            )}
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
      web: webViewStyle({ position: 'sticky' }),
    }),
  },
  stickyHeaderContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    height: '100%',
  },
  stickyHeaderCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minWidth: 0,
  },
  stickyHeaderImageContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
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
      web: { cursor: 'pointer' },
    }),
  },
  stickyHeaderControlButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      web: { cursor: 'pointer' },
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
  artistTitle: {
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
  infoImage: {
    width: 64,
    height: 64,
    borderRadius: 32,
  },
  infoTextContainer: {
    flex: 1,
    minWidth: 0,
  },
  verifiedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  verifiedText: {
    fontSize: 13,
    fontWeight: '700',
  },
  bio: {
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
      web: { cursor: 'pointer' },
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
      web: { cursor: 'pointer' },
    }),
  },
  sectionHeader: {
    paddingHorizontal: 24,
    paddingBottom: 16,
    paddingTop: 8,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    letterSpacing: -0.5,
  },
  trackList: {
    paddingHorizontal: 24,
    gap: 4,
  },
  albumsGrid: {
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
  relatedArtistsRow: {
    paddingHorizontal: 24,
    paddingBottom: 24,
    gap: 8,
  },
  relatedArtistCard: {
    width: 160,
  },
  emptyState: {
    paddingVertical: 48,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  emptyStateText: {
    fontSize: 14,
  },
});

export default EntityProfileScreen;
