import React, { useMemo } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { radioSeedTypeSchema, type RadioSeed, type Track } from '@syra/shared-types';
import SEO from '@/components/SEO';
import { TrackRow } from '@/components/TrackRow';
import { EmptyState } from '@/components/common/EmptyState';
import { GuestPreviewGate } from '@/components/GuestPreviewGate';
import { TrackListSkeleton } from '@/components/skeletons';
import { useRadioStation, useResetRadioStation } from '@/hooks/useRadio';
import { useAuthGate } from '@/hooks/useAuthGate';
import { usePlayerStore } from '@/stores/playerStore';

/**
 * A Syra Radio station (`/radio/<seedType>[/<seedId>]`).
 *
 * The route is a catch-all rather than `/radio/[seedType]/[seedId]` because the
 * `user` station has no seed id at all — the listener is the seed — and
 * expo-router will not match an empty dynamic segment. A catch-all gives
 * `/radio/user` and `/radio/artist/<id>` from one file with no sentinel id
 * standing in for "nothing".
 *
 * A station is stateful server-side: every page advances its generator, so
 * pages are appended and never refetched (see {@link useRadioStation}). Reaching
 * the end of the list asks for the next page; "restart" is the only way back to
 * the beginning.
 */
const RadioStationScreen: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const params = useLocalSearchParams<{ seed: string | string[] }>();
  const gate = useAuthGate();
  const { playTrackList, currentTrack, isPlaying } = usePlayerStore();

  // `/radio/user` yields one segment, `/radio/artist/<id>` two. A hand-typed
  // seed type that is not in the contract resolves to `null` and renders the
  // not-found branch below instead of firing a request that cannot succeed.
  const seed = useMemo<RadioSeed | null>(() => {
    const segments = Array.isArray(params.seed)
      ? params.seed
      : params.seed
        ? [params.seed]
        : [];
    const seedType = radioSeedTypeSchema.safeParse(segments[0]);
    if (!seedType.success) {
      return null;
    }
    return { seedType: seedType.data, seedId: segments[1] ?? '' };
  }, [params.seed]);

  const station = useRadioStation(seed);
  const resetStation = useResetRadioStation();

  const pages = useMemo(() => station.data?.pages ?? [], [station.data]);
  const tracks = useMemo(() => pages.flatMap((page) => page.tracks), [pages]);
  // Presentation comes from the first page; later pages describe the same station.
  const stationInfo = pages[0]?.station;
  // The preview wall, once any page has reported it. From there the station has
  // nothing more to hand this listener, so pagination stops.
  const previewGate = pages.find((page) => page.gate !== null)?.gate ?? null;

  const title = stationInfo?.title ?? t('radio.station.fallbackTitle');

  if (!seed) {
    return (
      <EmptyState
        containerStyle={{ backgroundColor: theme.colors.backgroundSecondary }}
        icon={{ name: 'radio-outline' }}
        title={t('radio.errors.unknownStation')}
        subtitle={t('radio.errors.unknownStationMessage')}
      />
    );
  }

  // Terminal auth failure — the session never resolved within the gate's bound.
  // The station is identity-sensitive, so this is an error with a retry rather
  // than a skeleton that never resolves.
  if (gate.isTimedOut) {
    return (
      <EmptyState
        containerStyle={{ backgroundColor: theme.colors.backgroundSecondary }}
        icon={{ name: 'cloud-offline-outline' }}
        error={{
          title: t('common.sessionUnavailable'),
          message: t('common.sessionErrorMessage'),
          onRetry: async () => {
            gate.retry();
          },
        }}
      />
    );
  }

  if (gate.isResolving || station.isLoading) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <View style={styles.list}>
          <TrackListSkeleton count={8} />
        </View>
      </View>
    );
  }

  // Only a station that produced NOTHING fails the whole screen. A later page
  // failing leaves the tracks already handed out on screen — refetching the
  // station to recover one page would burn the catalogue it already spent.
  if (station.isError && tracks.length === 0) {
    return (
      <EmptyState
        containerStyle={{ backgroundColor: theme.colors.backgroundSecondary }}
        icon={{ name: 'cloud-offline-outline' }}
        error={{
          title: t('radio.errors.load'),
          message: t('common.retryHint'),
          onRetry: async () => {
            await station.refetch();
          },
        }}
      />
    );
  }

  const playFrom = (track: Track) => {
    const index = Math.max(0, tracks.findIndex((item) => item.id === track.id));
    playTrackList(tracks, index, { type: 'radio', name: title, radio: seed });
  };

  const loadMore = () => {
    if (previewGate || !station.hasNextPage || station.isFetchingNextPage) {
      return;
    }
    station.fetchNextPage();
  };

  return (
    <>
      <SEO title={t('radio.seo.title', { station: title })} description={stationInfo?.subtitle} />
      <View style={[styles.container, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <FlatList
          data={tracks}
          keyExtractor={(track) => track.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          renderItem={({ item, index }) => {
            const isCurrentTrack = currentTrack?.id === item.id;
            return (
              <TrackRow
                track={item}
                index={index}
                isCurrentTrack={isCurrentTrack}
                isTrackPlaying={isCurrentTrack && isPlaying}
                onPress={() => playFrom(item)}
                onPlayPress={() => playFrom(item)}
                showNumber
              />
            );
          }}
          ListHeaderComponent={
            <View style={styles.header}>
              <View style={[styles.artwork, { backgroundColor: theme.colors.background }]}>
                {stationInfo?.imageUrl ? (
                  <Image
                    source={{ uri: stationInfo.imageUrl }}
                    style={styles.artworkImage}
                    contentFit="cover"
                  />
                ) : (
                  <Ionicons name="radio" size={48} color={theme.colors.textSecondary} />
                )}
              </View>
              <View style={styles.headerText}>
                <Text style={[styles.headerLabel, { color: theme.colors.textSecondary }]}>
                  {t('radio.label')}
                </Text>
                <Text style={[styles.headerTitle, { color: theme.colors.text }]} numberOfLines={2}>
                  {title}
                </Text>
                {stationInfo?.subtitle ? (
                  <Text
                    style={[styles.headerSubtitle, { color: theme.colors.textSecondary }]}
                    numberOfLines={2}
                  >
                    {stationInfo.subtitle}
                  </Text>
                ) : null}
                <Pressable
                  style={styles.restartButton}
                  onPress={() => resetStation.mutate(seed)}
                  disabled={resetStation.isPending}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: resetStation.isPending }}
                  accessibilityLabel={t('radio.restart')}
                  hitSlop={8}
                >
                  <Ionicons name="refresh" size={16} color={theme.colors.textSecondary} />
                  <Text style={[styles.restartLabel, { color: theme.colors.textSecondary }]}>
                    {t('radio.restart')}
                  </Text>
                </Pressable>
              </View>
            </View>
          }
          ListEmptyComponent={
            <EmptyState
              containerStyle={styles.state}
              icon={{ name: 'radio-outline' }}
              title={t('radio.empty.title')}
              subtitle={t('radio.empty.subtitle')}
            />
          }
          ListFooterComponent={
            previewGate ? (
              <GuestPreviewGate gate={previewGate} />
            ) : station.isFetchingNextPage ? (
              <View style={styles.footerSkeleton}>
                <TrackListSkeleton count={3} />
              </View>
            ) : station.isError ? (
              <EmptyState
                containerStyle={styles.state}
                icon={{ name: 'cloud-offline-outline' }}
                error={{
                  title: t('radio.errors.loadMore'),
                  message: t('common.retryHint'),
                  onRetry: async () => {
                    await station.fetchNextPage();
                  },
                }}
              />
            ) : null
          }
        />
      </View>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  list: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 100,
    gap: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    paddingBottom: 24,
  },
  artwork: {
    width: 128,
    height: 128,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  artworkImage: {
    width: '100%',
    height: '100%',
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  headerLabel: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  headerTitle: {
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: -0.8,
    marginTop: 4,
  },
  headerSubtitle: {
    fontSize: 14,
    marginTop: 8,
    lineHeight: 20,
  },
  restartButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    marginTop: 16,
    ...Platform.select({
      web: { cursor: 'pointer' },
    }),
  },
  restartLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  // `EmptyState` fills a screen by default; inside the list it sizes to content.
  state: {
    flex: 0,
    backgroundColor: 'transparent',
    paddingVertical: 32,
  },
  footerSkeleton: {
    paddingTop: 4,
  },
});

export default RadioStationScreen;
