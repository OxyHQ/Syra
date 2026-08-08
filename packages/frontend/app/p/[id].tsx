import React, { useEffect } from 'react';
import { StyleSheet, View, Text, Pressable, Image, ScrollView, Platform, Linking } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import Animated, {
  interpolate,
  useAnimatedRef,
  useAnimatedStyle,
  useScrollViewOffset,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useTranslation } from 'react-i18next';
import { useTheme, useAmbientTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { toast } from '@oxyhq/bloom/toast';
import { Track } from '@syra/shared-types';
import { entityService } from '@/services/entityService';
import { ArtistClaimCta } from '@/components/artist/ArtistClaimCta';
import { ArtistFollowControl } from '@/components/artist/ArtistFollowControl';
import { usePlayerStore } from '@/stores/playerStore';
import { usePlayEntity } from '@/hooks/usePlayEntity';
import SEO from '@/components/SEO';
import { TrackRow } from '@/components/TrackRow';
import { EpisodeRow } from '@/components/EpisodeRow';
import { MediaCard } from '@/components/MediaCard';
import { ResponsiveGrid } from '@/components/ResponsiveGrid';
import { ArtistDetailSkeleton } from '@/components/skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { oxyImageVariantForTarget, pickCatalogImageUrl, resolvePodcastArtwork, type CatalogImageTarget } from '@/utils/pickImage';
import { oxyServices } from '@/lib/oxyServices';
import { useRelatedArtists } from '@/hooks/useRecommendations';
import { useAuthGate } from '@/hooks/useAuthGate';
import { CATALOG_QUERY_KEYS } from '@/hooks/useLibraryCollections';
import { isNotFoundError } from '@/utils/api';
import { webViewStyle } from '@/utils/webStyles';
import { createScopedLogger } from '@/utils/logger';

const logger = createScopedLogger('EntityProfile');

const HEADER_HEIGHT = 400;

type EntityProfile = NonNullable<Awaited<ReturnType<typeof entityService.getEntityProfile>>>;
type RelatedArtist = NonNullable<ReturnType<typeof useRelatedArtists>['data']>['artists'][number];
type AppearsInEpisode = NonNullable<NonNullable<EntityProfile['appearsIn']>['episodes']>[number];

/** One album shelf: the release-type split the backend already computed. */
interface AlbumShelf {
  key: string;
  titleKey: string;
  albums: NonNullable<EntityProfile['discography']>['albums'];
}

/**
 * Outbound links, in the order they are rendered.
 *
 * A declared list rather than `Object.entries(links)`: it fixes the order, and
 * it pairs each key with its icon at the point the key is named, so a link added
 * to the contract cannot appear here without someone choosing how it looks.
 */
const ARTIST_LINKS: { key: keyof NonNullable<EntityProfile['links']>; icon: keyof typeof Ionicons.glyphMap; label: string }[] = [
  { key: 'website', icon: 'globe-outline', label: 'Website' },
  { key: 'instagram', icon: 'logo-instagram', label: 'Instagram' },
  { key: 'x', icon: 'logo-twitter', label: 'X' },
  { key: 'youtube', icon: 'logo-youtube', label: 'YouTube' },
  { key: 'soundcloud', icon: 'cloud-outline', label: 'SoundCloud' },
  { key: 'bandcamp', icon: 'musical-notes-outline', label: 'Bandcamp' },
  { key: 'discogs', icon: 'disc-outline', label: 'Discogs' },
  { key: 'wikipedia', icon: 'book-outline', label: 'Wikipedia' },
  { key: 'wikidata', icon: 'library-outline', label: 'Wikidata' },
];

/**
 * Unified entity profile screen (`/p/[id]`) — a merged music **artist** +
 * podcast **person** page driven by `GET /api/p/:id` (`EntityProfile`). Ports
 * the artist screen (parallax hero, play-all, popular tracks, albums, related
 * artists, follow) for the `music` half, and adds an "Appears in" section for
 * the `appearsIn` (podcasts/episodes) half. A linked entity shows both.
 */
const EntityProfileScreen: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const { playTrackList, playEpisode, startRadio, currentTrack, currentEpisode, isPlaying } = usePlayerStore();
  // The albums, shows and related artists on this profile are all playable, so
  // their cards get real play buttons from the one shared hook.
  const { playAlbum, playPodcast, playArtist } = usePlayEntity();
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
      return oxyServices.getFileDownloadUrl(entity.avatar, oxyImageVariantForTarget(target));
    }
    return undefined;
  };

  const displayName = entity ? (entity.displayName || entity.name) : '';

  const heroImage = entityImage('hero');

  // VIEW MODE: theme the WHOLE app from the profile's server-extracted cover
  // colours ON VIEW and restore the default on leave. All theming lives in Bloom —
  // this thin effect only feeds the cover colours to Bloom's ambient store
  // (consumed internally by the root provider). Runs before the early returns so
  // the hook order stays stable; no-ops until the entity loads.
  const { setAmbient, clearAmbient } = useAmbientTheme();
  const entityPrimaryColor = entity?.primaryColor;
  const entitySecondaryColor = entity?.secondaryColor;
  useEffect(() => {
    if (entityPrimaryColor) {
      setAmbient(entityPrimaryColor, { secondary: entitySecondaryColor });
    }
    return () => clearAmbient();
  }, [entityPrimaryColor, entitySecondaryColor, setAmbient, clearAmbient]);

  const handlePlayAll = () => {
    if (tracks.length === 0) {
      toast.info(t('common.noPlayableTracks'));
      return;
    }
    playTrackList(tracks, 0, { type: 'artist', id: artistId, name: displayName });
  };

  const handleTrackPress = (track: Track) => {
    const index = Math.max(0, tracks.findIndex((item) => item.id === track.id));
    playTrackList(tracks, index, { type: 'artist', id: artistId, name: displayName });
  };

  /**
   * Play a track this artist is only credited on.
   *
   * Played on its own rather than inside `tracks`: `creditedOn` entries are not
   * in this artist's own list, so seeding the queue from `tracks` would either
   * fail to find the track or start something else entirely.
   */
  const handleCreditedTrackPress = (track: Track) => {
    playTrackList([track], 0, { type: 'track', id: track.id, name: track.title });
  };

  const handleOpenLink = (url: string) => {
    void Linking.openURL(url).catch((error: unknown) => {
      toast.error(t('artist.linkFailed'));
      logger.warn('Failed to open artist link', { url, error });
    });
  };

  // A station seeded on this artist — the endless counterpart to "play all",
  // and the same discovery thread the "fans also like" rail below pulls on.
  const handleStartRadio = () => {
    if (!artistId) {
      return;
    }
    startRadio({ seedType: 'artist', seedId: artistId });
  };

  // Terminal auth failure — the session never resolved within the gate's bound.
  // Rendered as an error the user can act on, never as an endless skeleton.
  if (gate.isTimedOut) {
    return (
      <EmptyState
        className="bg-surface"
        icon={{ name: 'cloud-offline-outline' }}
        error={{
          title: t('common.sessionUnavailable'),
          message: t('artist.errors.session'),
          onRetry: async () => {
            gate.retry();
          },
        }}
      />
    );
  }

  if (isCatalogLoading) {
    return (
      <View className="bg-surface" style={styles.container}>
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
        className="bg-surface"
        icon={{ name: 'cloud-offline-outline' }}
        error={{
          title: t('artist.errors.load'),
          message: t('artist.errors.message'),
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
        className="bg-surface"
        icon={{ name: 'person-outline' }}
        title={t('artist.notFound')}
        subtitle={t('artist.notFoundMessage')}
      />
    );
  }

  // The whole app is themed from this profile's hero cover ON VIEW (see the
  // ambient effect above). No per-screen theme wrapper and no cover-hover
  // theming — `EntityProfileView` reads the already-themed app theme.
  return (
    <EntityProfileView
      entity={entity}
      displayName={displayName}
      artistId={artistId}
      relatedArtists={relatedArtists}
      relatedArtistsPending={relatedArtistsQuery.isPending}
      heroImage={heroImage}
      smallImage={entityImage('smallArtwork')}
      iconImage={entityImage('icon')}
      currentTrackId={currentTrack?.id}
      currentEpisodeId={currentEpisode?.id}
      isPlaying={isPlaying}
      onPlayAll={handlePlayAll}
      onStartRadio={handleStartRadio}
      onTrackPress={handleTrackPress}
      onPlayEpisode={playEpisode}
      onPlayAlbum={playAlbum}
      onPlayPodcast={playPodcast}
      onPlayArtist={playArtist}
      onNavigateArtist={(artist) => router.push({ pathname: '/p/[id]', params: { id: artist } })}
      onNavigateAlbum={(album) => router.push(`/album/${album}`)}
      onNavigatePodcast={(podcast) => router.push({ pathname: '/podcasts/[id]', params: { id: podcast } })}
      onNavigateEpisode={(episode) => router.push({ pathname: '/episode/[id]', params: { id: episode } })}
      onNavigatePlaylist={(playlist) => router.push({ pathname: '/playlist/[id]', params: { id: playlist } })}
      onCreditedTrackPress={handleCreditedTrackPress}
      onOpenLink={handleOpenLink}
    />
  );
};

interface EntityProfileViewProps {
  entity: EntityProfile;
  displayName: string;
  artistId: string | undefined;
  relatedArtists: RelatedArtist[];
  relatedArtistsPending: boolean;
  heroImage: string | undefined;
  smallImage: string | undefined;
  iconImage: string | undefined;
  currentTrackId: string | undefined;
  currentEpisodeId: string | undefined;
  isPlaying: boolean;
  onPlayAll: () => void;
  onStartRadio: () => void;
  onTrackPress: (track: Track) => void;
  onPlayEpisode: (episode: AppearsInEpisode) => void;
  onPlayAlbum: (albumId: string, albumTitle?: string) => void;
  onPlayPodcast: (podcastId: string, podcastTitle?: string) => void;
  onPlayArtist: (artistId: string, artistName?: string) => void;
  onNavigateArtist: (artistId: string) => void;
  onNavigateAlbum: (albumId: string) => void;
  onNavigatePodcast: (podcastId: string) => void;
  onNavigateEpisode: (episodeId: string) => void;
  onNavigatePlaylist: (playlistId: string) => void;
  /**
   * Play a track this artist is only CREDITED on. Separate from `onTrackPress`
   * because the context differs: a credited track belongs to somebody else's
   * catalogue, so it must not be played as if it were an item in this artist's
   * own list — the queue would then be a list this page never showed.
   */
  onCreditedTrackPress: (track: Track) => void;
  onOpenLink: (url: string) => void;
}

/**
 * The profile's presentational view. Reads the app theme via `useTheme()`; the
 * app is already themed from the hero cover on view (see the ambient effect in
 * `EntityProfileScreen`), so the hero + sections reflect the artwork palette with
 * no cover-hover handling here. Owns the parallax scroll hooks.
 */
const EntityProfileView: React.FC<EntityProfileViewProps> = ({
  entity,
  displayName,
  artistId,
  relatedArtists,
  relatedArtistsPending,
  heroImage,
  smallImage,
  iconImage,
  currentTrackId,
  currentEpisodeId,
  isPlaying,
  onPlayAll,
  onStartRadio,
  onTrackPress,
  onPlayEpisode,
  onPlayAlbum,
  onPlayPodcast,
  onPlayArtist,
  onNavigateArtist,
  onNavigateAlbum,
  onNavigatePodcast,
  onNavigateEpisode,
  onNavigatePlaylist,
  onCreditedTrackPress,
  onOpenLink,
}) => {
  const { t } = useTranslation();
  const theme = useTheme();
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollOffset = useScrollViewOffset(scrollRef);

  const tracks = entity.music?.tracks ?? [];
  const podcasts = entity.appearsIn?.podcasts ?? [];
  const episodes = entity.appearsIn?.episodes ?? [];
  const canPlay = tracks.length > 0;

  const discography = entity.discography;
  const creditedOn = entity.creditedOn ?? [];
  const playlists = entity.playlists ?? [];
  const profileState = entity.profileState;

  /**
   * The album shelves, split by release type.
   *
   * `discography` is the authority when the serializer supplies it. `music.albums`
   * is the fallback for a profile that has no artist half (or an older response),
   * and it is rendered as ONE shelf rather than being partitioned here — the
   * `single | ep` → "Singles & EPs" mapping lives on the backend precisely so it
   * does not get a second implementation.
   */
  const albumShelves: AlbumShelf[] = discography
    ? [
        { key: 'albums', titleKey: 'common.albums', albums: discography.albums },
        { key: 'singlesAndEps', titleKey: 'artist.singlesAndEps', albums: discography.singlesAndEps },
        { key: 'compilations', titleKey: 'artist.compilations', albums: discography.compilations },
      ]
    : [{ key: 'albums', titleKey: 'common.albums', albums: entity.music?.albums ?? [] }];

  // Only for the count in the metadata line; the shelves render themselves.
  const albums = discography
    ? [...discography.albums, ...discography.singlesAndEps, ...discography.compilations]
    : entity.music?.albums ?? [];

  /**
   * Recordings on this page that a third party contributed rather than the
   * artist uploading them. A `Set` because it is asked once per rendered row.
   */
  const contributedTrackIds = new Set(profileState?.contributedTrackIds ?? []);

  /**
   * Which profile values did not come from the artist.
   *
   * `externallySourcedFields` is already the flattened union of every
   * `sources[].fields`, so this only maps the field names to labels — it never
   * walks provenance rows.
   */
  const externallySourced = profileState?.externallySourcedFields ?? [];

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
      <View className="bg-surface" style={styles.container}>
        {/* Sticky Header */}
        <Animated.View
          className="bg-background border-b-surface"
          style={[styles.stickyHeader, stickyHeaderAnimatedStyle]}
          pointerEvents="box-none"
        >
          <View style={styles.stickyHeaderContent}>
            <View style={styles.stickyHeaderCenter}>
              <View className="bg-surface" style={styles.stickyHeaderImageContainer}>
                {iconImage ? (
                  <Image source={{ uri: iconImage }} style={styles.stickyHeaderImage} resizeMode="cover" />
                ) : (
                  <Ionicons name="person" size={20} color={theme.colors.textSecondary} />
                )}
              </View>
              <Text className="text-foreground" style={styles.stickyHeaderTitle} numberOfLines={1}>
                {displayName}
              </Text>
              {entity.verified ? (
                <Ionicons name="checkmark-circle" size={16} color={theme.colors.primary} />
              ) : null}
            </View>

            <View style={styles.stickyHeaderControls}>
              {canPlay && (
                <Pressable
                  className="bg-primary" style={styles.stickyHeaderPlayButton}
                  onPress={onPlayAll}
                  accessibilityRole="button"
                >
                  <Ionicons name="play" size={16} color={theme.colors.primaryForeground} />
                </Pressable>
              )}
              {artistId && (
                <ArtistFollowControl
                  artistId={artistId}
                  artistName={displayName}
                  size="small"
                  showOptions={false}
                />
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
                <View className="bg-surface" style={styles.headerPlaceholder}>
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
                      <Text className="text-foreground" style={styles.verifiedText}>{t('artist.verified')}</Text>
                    </View>
                  ) : null}
                  {entity.bio ? (
                    <Text className="text-muted-foreground" style={styles.bio} numberOfLines={3}>
                      {entity.bio}
                    </Text>
                  ) : null}
                  {metadata ? (
                    <View style={styles.metadataRow}>
                      <Text className="text-muted-foreground" style={styles.metadata}>{metadata}</Text>
                    </View>
                  ) : null}
                  {entity.country ? (
                    <View style={styles.metadataRow}>
                      <Ionicons name="location-outline" size={14} color={theme.colors.textSecondary} />
                      <Text className="text-muted-foreground" style={styles.metadata}>
                        {entity.country}
                      </Text>
                    </View>
                  ) : null}

                  {/* Outbound links. Only the ones actually present render —
                      enrichment lands incrementally, so a fixed row of dead
                      icons would misrepresent what is known about the artist. */}
                  {entity.links ? (
                    <View style={styles.linksRow}>
                      {ARTIST_LINKS.map(({ key, icon, label }) => {
                        const href = entity.links?.[key];
                        if (!href) {
                          return null;
                        }
                        return (
                          <Pressable
                            key={key}
                            onPress={() => onOpenLink(href)}
                            className="bg-popover" style={styles.linkChip}
                            accessibilityRole="link"
                            accessibilityLabel={label}
                          >
                            <Ionicons name={icon} size={14} color={theme.colors.text} />
                            <Text className="text-foreground" style={styles.linkChipText}>{label}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}

                  {/* What the artist did not write. Shown because a claimed
                      profile lets them overwrite it, and they cannot decide what
                      to replace without knowing which values came from outside. */}
                  {externallySourced.length > 0 ? (
                    <Text className="text-muted-foreground" style={styles.provenanceNote}>
                      {t('artist.externallySourced', { fields: externallySourced.join(', ') })}
                    </Text>
                  ) : null}
                </View>
              </View>

              {/* Claim CTA — contributed profile, still unclaimed. */}
              {artistId && profileState?.origin === 'contributed' && profileState.claimable ? (
                <ArtistClaimCta artistId={artistId} artistName={displayName} />
              ) : null}
            </View>

            {/* Playback Controls (music) */}
            {(canPlay || artistId) && (
              <View style={styles.controlsContainer}>
                {canPlay && (
                  <Pressable
                    className="bg-primary" style={styles.playButton}
                    onPress={onPlayAll}
                    accessibilityRole="button"
                  >
                    <View style={styles.playButtonInner}>
                      <Ionicons name="play" size={24} color={theme.colors.primaryForeground} />
                    </View>
                  </Pressable>
                )}
                {artistId && (
                  <ArtistFollowControl artistId={artistId} artistName={displayName} />
                )}
                {artistId && (
                  <Pressable
                    style={styles.controlButton}
                    onPress={onStartRadio}
                    accessibilityRole="button"
                    accessibilityLabel={t('radio.artistRadio')}
                  >
                    <Ionicons name="radio-outline" size={24} color={theme.colors.text} />
                  </Pressable>
                )}
              </View>
            )}

            {/* Popular Tracks Section */}
            {tracks.length > 0 && (
              <>
                <View style={styles.sectionHeader}>
                  <Text className="text-foreground" style={styles.sectionTitle}>{t('artist.popular')}</Text>
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
                        // Published by a listener, not by the artist. A claimed
                        // artist otherwise sees a discography containing
                        // recordings they never uploaded, with no way to tell.
                        badge={contributedTrackIds.has(track.id) ? t('artist.contributedBadge') : undefined}
                      />
                    );
                  })}
                </View>
              </>
            )}

            {/* Discography — three shelves off the release-type split the
                backend computed. A shelf with nothing in it does not render at
                all, rather than opening onto an empty grid. */}
            {albumShelves.map((shelf) =>
              shelf.albums.length === 0 ? null : (
                <React.Fragment key={shelf.key}>
                  <View style={styles.sectionHeader}>
                    <Text className="text-foreground" style={styles.sectionTitle}>{t(shelf.titleKey)}</Text>
                  </View>
                  <ResponsiveGrid minItemWidth={180} gap={8} style={styles.albumsGrid}>
                    {shelf.albums.map((album) => (
                      <View key={album.id}>
                        <MediaCard
                          title={album.title}
                          subtitle={album.artistName}
                          type="album"
                          imageUri={album.coverArt}
                          imageSizes={album.coverArtSizes}
                          primaryColor={album.primaryColor}
                          onPress={() => onNavigateAlbum(album.id)}
                          onPlayPress={() => onPlayAlbum(album.id, album.title)}
                        />
                      </View>
                    ))}
                  </ResponsiveGrid>
                </React.Fragment>
              ),
            )}

            {/* Appears on — tracks this artist took part in WITHOUT being the
                primary artist. Only expressible since `Track.credits[]` exists;
                before that a guest verse or a production credit had nowhere to
                live, so this shelf could not have been built at all. */}
            {creditedOn.length > 0 && (
              <>
                <View style={styles.sectionHeader}>
                  <Text className="text-foreground" style={styles.sectionTitle}>
                    {t('artist.appearsOn')}
                  </Text>
                </View>
                <View style={styles.trackList}>
                  {creditedOn.map((credited, index) => {
                    const isCurrentTrack = currentTrackId === credited.track.id;
                    return (
                      <TrackRow
                        key={credited.track.id}
                        track={credited.track}
                        index={index}
                        isCurrentTrack={isCurrentTrack}
                        isTrackPlaying={isCurrentTrack && isPlaying}
                        onPress={() => onCreditedTrackPress(credited.track)}
                        onPlayPress={() => onCreditedTrackPress(credited.track)}
                        showNumber={false}
                        // The roles ARE the reason this row is on this page —
                        // "featured" and "produced" are different facts, and one
                        // person is routinely several of them on one recording.
                        badge={credited.roles.length > 0 ? credited.roles.join(', ') : undefined}
                      />
                    );
                  })}
                </View>
              </>
            )}

            {/* Playlists that include this artist and that the viewer may read. */}
            {playlists.length > 0 && (
              <>
                <View style={styles.sectionHeader}>
                  <Text className="text-foreground" style={styles.sectionTitle}>
                    {t('artist.inPlaylists')}
                  </Text>
                </View>
                <ResponsiveGrid minItemWidth={180} gap={8} style={styles.albumsGrid}>
                  {playlists.map((playlist) => (
                    <View key={playlist.id}>
                      <MediaCard
                        title={playlist.name}
                        subtitle={t('common.songCount', { count: playlist.trackCount ?? 0 })}
                        type="playlist"
                        imageUri={playlist.coverArt}
                        imageSizes={playlist.coverArtSizes}
                        onPress={() => onNavigatePlaylist(playlist.id)}
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
                  <Text className="text-foreground" style={styles.sectionTitle}>{t('artist.appearsIn')}</Text>
                </View>
                <ResponsiveGrid minItemWidth={160} gap={8} style={styles.albumsGrid}>
                  {podcasts.map((podcast) => (
                    <View key={podcast.id}>
                      <MediaCard
                        title={podcast.title}
                        subtitle={podcast.author ?? t('common.podcast')}
                        type="podcast"
                        resolvedImageUri={resolvePodcastArtwork(podcast, 'card')}
                        primaryColor={podcast.primaryColor}
                        onPress={() => onNavigatePodcast(podcast.id)}
                        onPlayPress={() => onPlayPodcast(podcast.id, podcast.title)}
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
                  <Text className="text-foreground" style={styles.sectionTitle}>{t('common.episodes')}</Text>
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
                  <Text className="text-foreground" style={styles.sectionTitle}>
                    {t('artist.fansAlsoLike')}
                  </Text>
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.relatedArtistsRow}>
                  {relatedArtists.map((relatedArtist) => (
                    <View key={relatedArtist.id} style={styles.relatedArtistCard}>
                      <MediaCard
                        title={relatedArtist.name}
                        subtitle={t('common.artist')}
                        type="artist"
                        imageUri={relatedArtist.image}
                        images={relatedArtist.images}
                        imageSizes={relatedArtist.imageSizes}
                        primaryColor={relatedArtist.primaryColor}
                        onPress={() => onNavigateArtist(relatedArtist.id)}
                        onPlayPress={() => onPlayArtist(relatedArtist.id, relatedArtist.name)}
                      />
                    </View>
                  ))}
                </ScrollView>
              </>
            )}

            {/* Empty State — counts every shelf, including the ones added with
                the credits work. A profile whose only content is a production
                credit is not empty, and saying so while rendering that credit
                directly above would contradict itself. */}
            {tracks.length === 0 &&
              albums.length === 0 &&
              podcasts.length === 0 &&
              episodes.length === 0 &&
              creditedOn.length === 0 &&
              playlists.length === 0 && (
              <View style={styles.emptyState}>
                <Text className="text-muted-foreground" style={styles.emptyStateText}>
                  {/* A contributed stub is sparse BY DESIGN for a while: the
                      profile is created from one file's tags and enrichment is
                      queued behind a rate-limited external source, so it can be
                      minutes or hours before anything else lands. Saying that is
                      the difference between a page that looks unfinished and one
                      that looks broken. */}
                  {profileState?.origin === 'contributed'
                    ? t('artist.emptyContributed')
                    : t('artist.empty')}
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
  linksRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  linkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  linkChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  provenanceNote: {
    fontSize: 11,
    lineHeight: 15,
    marginTop: 8,
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
