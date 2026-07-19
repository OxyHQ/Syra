import React, { useState, useMemo } from 'react';
import { StyleSheet, View, Text, ScrollView, Pressable, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import SEO from '@/components/SEO';
import { EpisodeRow } from '@/components/EpisodeRow';
import { HostsAndGuests } from '@/components/podcast/HostsAndGuests';
import { LibraryListSkeleton, PodcastDetailSkeleton } from '@/components/skeletons';
import {
  usePodcast,
  useEpisodes,
  useIsSubscribed,
  useToggleSubscription,
  useEpisodeProgressMap,
} from '@/hooks/usePodcasts';
import { usePlayerStore } from '@/stores/playerStore';
import { resolvePodcastImageUri } from '@/utils/podcastImages';
import { stripHtml } from '@/utils/podcastFormat';
import { webViewStyle } from '@/utils/webStyles';
import { AmbientArtworkTheme } from '@/components/AmbientArtworkTheme';
import { useArtworkSeed } from '@/hooks/useArtworkSeed';

/**
 * Podcast show screen — header (artwork, title, author, description), a Subscribe
 * toggle, and the full reverse-chronological episode list with resume progress.
 */
const PodcastShowScreen: React.FC = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const router = useRouter();

  const showQuery = usePodcast(id);
  const episodesQuery = useEpisodes(id);
  const progressMap = useEpisodeProgressMap();
  const isSubscribed = useIsSubscribed();
  const toggleSubscription = useToggleSubscription();
  const { seed, activate: activateSeed, deactivate: deactivateSeed } = useArtworkSeed();

  const currentEpisode = usePlayerStore((s) => s.currentEpisode);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playEpisodeList = usePlayerStore((s) => s.playEpisodeList);
  const pause = usePlayerStore((s) => s.pause);
  const resume = usePlayerStore((s) => s.resume);

  const podcast = showQuery.data?.podcast;
  const episodes = useMemo(
    () => episodesQuery.data?.episodes ?? showQuery.data?.episodes ?? [],
    [episodesQuery.data, showQuery.data],
  );

  const subscribed = podcast ? isSubscribed(podcast.id) : false;
  const artwork = resolvePodcastImageUri(podcast, 'detailArtwork');
  const description = stripHtml(podcast?.description);

  const handlePlayEpisode = (index: number) => {
    const episode = episodes[index];
    if (!episode) {
      return;
    }
    if (currentEpisode?.id === episode.id) {
      if (isPlaying) {
        pause();
      } else {
        resume();
      }
      return;
    }
    const context = podcast
      ? { type: 'podcast' as const, id: podcast.id, name: podcast.title }
      : undefined;
    playEpisodeList(episodes, index, context, progressMap.get(episode.id)?.progressSec);
  };

  if (showQuery.isPending) {
    return <PodcastDetailSkeleton />;
  }

  if (!podcast) {
    return (
      <View style={[styles.container, styles.center, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <Ionicons name="alert-circle-outline" size={48} color={theme.colors.textSecondary} />
        <Text style={[styles.errorText, { color: theme.colors.textSecondary }]}>Podcast not found</Text>
      </View>
    );
  }

  // Hover the cover → extract its dominant colour → re-theme the show's ambient
  // surfaces. `PodcastShowView` reads the scoped theme via `useTheme()` inside
  // the ambient region, so the hero + episode list ease into the artwork
  // palette; leaving the cover restores the app preset. Native is a no-op.
  return (
    <AmbientArtworkTheme seed={seed}>
      <PodcastShowView
        podcast={podcast}
        episodes={episodes}
        persons={showQuery.data?.persons ?? []}
        artwork={artwork}
        description={description}
        subscribed={subscribed}
        episodesPending={episodesQuery.isPending}
        currentEpisodeId={currentEpisode?.id}
        isPlaying={isPlaying}
        progressMap={progressMap}
        onCoverHoverIn={() => podcast.id && activateSeed(podcast.id, artwork)}
        onCoverHoverOut={deactivateSeed}
        onToggleSubscription={() =>
          toggleSubscription.mutate({ podcastId: podcast.id, next: !subscribed, podcast })
        }
        onPlayEpisode={handlePlayEpisode}
        onOpenEpisode={(episodeId) => router.push({ pathname: '/episode/[id]', params: { id: episodeId } })}
      />
    </AmbientArtworkTheme>
  );
};

interface PodcastShowViewProps {
  podcast: NonNullable<ReturnType<typeof usePodcast>['data']>['podcast'];
  episodes: NonNullable<ReturnType<typeof useEpisodes>['data']>['episodes'];
  persons: NonNullable<ReturnType<typeof usePodcast>['data']>['persons'];
  artwork: string | undefined;
  description: string;
  subscribed: boolean;
  episodesPending: boolean;
  currentEpisodeId: string | undefined;
  isPlaying: boolean;
  progressMap: ReturnType<typeof useEpisodeProgressMap>;
  onCoverHoverIn: () => void;
  onCoverHoverOut: () => void;
  onToggleSubscription: () => void;
  onPlayEpisode: (index: number) => void;
  onOpenEpisode: (episodeId: string) => void;
}

/**
 * The show's ambient region. Reads `useTheme()` INSIDE `<AmbientArtworkTheme>`
 * so its surfaces re-theme to the artwork seed while hovering the cover, then
 * revert to the app preset on hover-out.
 */
const PodcastShowView: React.FC<PodcastShowViewProps> = ({
  podcast,
  episodes,
  persons,
  artwork,
  description,
  subscribed,
  episodesPending,
  currentEpisodeId,
  isPlaying,
  progressMap,
  onCoverHoverIn,
  onCoverHoverOut,
  onToggleSubscription,
  onPlayEpisode,
  onOpenEpisode,
}) => {
  const theme = useTheme();
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

  // Cover-derived hero gradient, same shape as the album/artist screens.
  const gradientColors: readonly [string, string, string] = [
    podcast.primaryColor ?? theme.colors.backgroundSecondary,
    podcast.secondaryColor ?? theme.colors.backgroundSecondary,
    theme.colors.backgroundSecondary,
  ];

  return (
    <>
      <SEO title={`${podcast.title} - Syra`} description={description.slice(0, 160)} />
      <ScrollView
        style={[styles.container, { backgroundColor: theme.colors.backgroundSecondary }]}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Header — cover-derived gradient hero (bleeds past the content padding). */}
        <LinearGradient colors={gradientColors} locations={[0, 0.45, 1]} style={styles.hero}>
        <View style={styles.header}>
          {/* Show artwork — hover (web) / focus to tint the ambient region */}
          <Pressable
            onHoverIn={onCoverHoverIn}
            onHoverOut={onCoverHoverOut}
            onFocus={onCoverHoverIn}
            onBlur={onCoverHoverOut}
            accessibilityRole="image"
            accessibilityLabel={`${podcast.title} cover art`}
          >
            {artwork ? (
              <Image source={{ uri: artwork }} style={styles.headerArtwork} contentFit="cover" />
            ) : (
              <View style={[styles.headerArtworkPlaceholder, { backgroundColor: theme.colors.backgroundTertiary }]}>
                <Ionicons name="mic" size={48} color={theme.colors.textSecondary} />
              </View>
            )}
          </Pressable>
          <View style={styles.headerInfo}>
            <Text style={[styles.showTitle, { color: theme.colors.text }]} numberOfLines={3}>
              {podcast.title}
            </Text>
            {podcast.author ? (
              <Text style={[styles.showAuthor, { color: theme.colors.textSecondary }]} numberOfLines={2}>
                {podcast.author}
              </Text>
            ) : null}
            <Pressable
              onPress={onToggleSubscription}
              style={[
                styles.subscribeButton,
                subscribed
                  ? { borderColor: theme.colors.border, borderWidth: 1 }
                  : { backgroundColor: theme.colors.primary },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: subscribed }}
            >
              <Ionicons
                name={subscribed ? 'checkmark' : 'add'}
                size={18}
                color={subscribed ? theme.colors.text : theme.colors.primaryForeground}
              />
              <Text
                style={[
                  styles.subscribeText,
                  { color: subscribed ? theme.colors.text : theme.colors.primaryForeground },
                ]}
              >
                {subscribed ? 'Subscribed' : 'Subscribe'}
              </Text>
            </Pressable>
          </View>
        </View>
        </LinearGradient>

        {/* Description */}
        {description ? (
          <Pressable onPress={() => setDescriptionExpanded((value) => !value)} style={styles.descriptionWrap}>
            <Text
              style={[styles.description, { color: theme.colors.textSecondary }]}
              numberOfLines={descriptionExpanded ? undefined : 3}
            >
              {description}
            </Text>
            <Text style={[styles.descriptionToggle, { color: theme.colors.primary }]}>
              {descriptionExpanded ? 'Show less' : 'Show more'}
            </Text>
          </Pressable>
        ) : null}

        {/* Hosts & Guests */}
        <HostsAndGuests persons={persons} />

        {/* Episodes */}
        <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Episodes</Text>
        {episodesPending && episodes.length === 0 ? (
          <LibraryListSkeleton count={6} />
        ) : episodes.length === 0 ? (
          <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
            No episodes available yet.
          </Text>
        ) : (
          episodes.map((episode, index) => (
            <EpisodeRow
              key={episode.id}
              episode={episode}
              progress={progressMap.get(episode.id)}
              isCurrent={currentEpisodeId === episode.id}
              isPlaying={currentEpisodeId === episode.id && isPlaying}
              hideArtwork
              onPress={() => onOpenEpisode(episode.id)}
              onPlayPress={() => onPlayEpisode(index)}
            />
          ))
        )}
      </ScrollView>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  content: {
    padding: 16,
    paddingBottom: 120,
  },
  hero: {
    // Bleed the gradient past the ScrollView content padding to the panel edges,
    // mirroring the album/artist hero.
    marginHorizontal: -16,
    marginTop: -16,
    paddingHorizontal: 16,
    paddingTop: 16,
    marginBottom: 16,
  },
  header: {
    flexDirection: 'row',
    gap: 16,
  },
  headerArtwork: {
    width: 140,
    height: 140,
    borderRadius: 12,
  },
  headerArtworkPlaceholder: {
    width: 140,
    height: 140,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerInfo: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: 8,
  },
  showTitle: {
    fontSize: 22,
    fontWeight: 'bold',
  },
  showAuthor: {
    fontSize: 14,
  },
  subscribeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginTop: 4,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  subscribeText: {
    fontSize: 14,
    fontWeight: '700',
  },
  descriptionWrap: webViewStyle({
    marginBottom: 20,
    gap: 4,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  }),
  description: {
    fontSize: 14,
    lineHeight: 20,
  },
  descriptionToggle: {
    fontSize: 13,
    fontWeight: '600',
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    paddingVertical: 24,
    textAlign: 'center',
  },
  errorText: {
    fontSize: 16,
  },
});

export default PodcastShowScreen;
