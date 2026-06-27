import React, { useMemo } from 'react';
import { StyleSheet, View, Text, ScrollView, Pressable, Platform, Linking } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import SEO from '@/components/SEO';
import { ArtistDetailSkeleton } from '@/components/skeletons';
import { HostsAndGuests } from '@/components/podcast/HostsAndGuests';
import { useEpisode, useEpisodeChapters, useEpisodeProgress } from '@/hooks/usePodcasts';
import { usePlayerStore } from '@/stores/playerStore';
import { resolvePodcastImageUri } from '@/utils/podcastImages';
import { stripHtml, formatPubDate, formatEpisodeDuration } from '@/utils/podcastFormat';
import { formatDuration } from '@/utils/musicUtils';

/**
 * Episode detail — artwork, show/title, play/resume control, description,
 * Podcasting 2.0 chapters (tap to seek), transcript links, and host/guest
 * credits linked to Syra artists where resolved.
 */
const EpisodeScreen: React.FC = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const router = useRouter();

  const episodeQuery = useEpisode(id);
  const detail = episodeQuery.data;
  const episode = detail?.episode;
  // Per-user saved position (authed-only; undefined for guests / unplayed episodes).
  const progress = useEpisodeProgress(id);

  const chaptersQuery = useEpisodeChapters(episode?.chapters?.url);

  const currentEpisode = usePlayerStore((s) => s.currentEpisode);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playEpisode = usePlayerStore((s) => s.playEpisode);
  const pause = usePlayerStore((s) => s.pause);
  const resume = usePlayerStore((s) => s.resume);
  const seek = usePlayerStore((s) => s.seek);

  const isCurrent = currentEpisode?.id === id;
  const artwork = resolvePodcastImageUri(episode, 'detailArtwork');
  const description = useMemo(() => stripHtml(episode?.description ?? episode?.summary), [episode]);

  const handlePlay = () => {
    if (!episode) {
      return;
    }
    if (isCurrent) {
      if (isPlaying) {
        pause();
      } else {
        resume();
      }
      return;
    }
    playEpisode(episode, { resumeFromSec: progress?.progressSec });
  };

  const handleChapterPress = (startTime: number) => {
    if (!episode) {
      return;
    }
    if (isCurrent) {
      seek(startTime);
    } else {
      playEpisode(episode, { resumeFromSec: startTime });
    }
  };

  if (episodeQuery.isPending) {
    return <ArtistDetailSkeleton />;
  }

  if (!episode) {
    return (
      <View style={[styles.container, styles.center, { backgroundColor: theme.colors.background }]}>
        <Ionicons name="alert-circle-outline" size={48} color={theme.colors.textSecondary} />
        <Text style={[styles.errorText, { color: theme.colors.textSecondary }]}>Episode not found</Text>
      </View>
    );
  }

  const metaParts = [formatPubDate(episode.pubDate), formatEpisodeDuration(episode.duration)].filter(Boolean);
  const playLabel = isCurrent && isPlaying
    ? 'Pause'
    : (progress?.progressSec ?? 0) > 5 && !progress?.completed
      ? 'Resume'
      : 'Play';

  return (
    <>
      <SEO title={`${episode.title} - Syra`} description={description.slice(0, 160)} />
      <ScrollView
        style={[styles.container, { backgroundColor: theme.colors.background }]}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          {artwork ? (
            <Image source={{ uri: artwork }} style={styles.artwork} contentFit="cover" />
          ) : (
            <View style={[styles.artworkPlaceholder, { backgroundColor: theme.colors.backgroundTertiary }]}>
              <Ionicons name="mic" size={48} color={theme.colors.textSecondary} />
            </View>
          )}
          <Pressable
            onPress={() => router.push({ pathname: '/podcasts/[id]', params: { id: episode.podcastId } })}
            accessibilityRole="link"
          >
            <Text style={[styles.showLink, { color: theme.colors.primary }]} numberOfLines={1}>
              {episode.podcastTitle}
            </Text>
          </Pressable>
          <Text style={[styles.title, { color: theme.colors.text }]}>{episode.title}</Text>
          {metaParts.length > 0 && (
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>{metaParts.join(' • ')}</Text>
          )}

          <Pressable
            onPress={handlePlay}
            style={[styles.playButton, { backgroundColor: theme.colors.primary }]}
            accessibilityRole="button"
            accessibilityLabel={playLabel}
          >
            <Ionicons
              name={isCurrent && isPlaying ? 'pause' : 'play'}
              size={20}
              color={theme.colors.primaryForeground}
            />
            <Text style={[styles.playButtonText, { color: theme.colors.primaryForeground }]}>{playLabel}</Text>
          </Pressable>
        </View>

        {/* Hosts & Guests */}
        {detail && <HostsAndGuests persons={detail.persons} />}

        {/* Chapters */}
        {chaptersQuery.data && chaptersQuery.data.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Chapters</Text>
            {chaptersQuery.data.map((chapter, index) => (
              <Pressable
                key={`${chapter.startTime}-${index}`}
                onPress={() => handleChapterPress(chapter.startTime)}
                style={styles.chapterRow}
              >
                <Text style={[styles.chapterTime, { color: theme.colors.textSecondary }]}>
                  {formatDuration(chapter.startTime)}
                </Text>
                <Text style={[styles.chapterTitle, { color: theme.colors.text }]} numberOfLines={1}>
                  {chapter.title ?? 'Untitled chapter'}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* Transcripts */}
        {episode.transcripts && episode.transcripts.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Transcript</Text>
            {episode.transcripts.map((transcript, index) => (
              <Pressable
                key={`${transcript.url}-${index}`}
                onPress={() => Linking.openURL(transcript.url)}
                style={styles.linkRow}
              >
                <Ionicons name="document-text-outline" size={18} color={theme.colors.primary} />
                <Text style={[styles.linkText, { color: theme.colors.primary }]} numberOfLines={1}>
                  {transcript.language ? `Transcript (${transcript.language})` : 'View transcript'}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* Description */}
        {description ? (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>About</Text>
            <Text style={[styles.description, { color: theme.colors.textSecondary }]}>{description}</Text>
          </View>
        ) : null}
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
  header: {
    alignItems: 'center',
    gap: 8,
    marginBottom: 24,
  },
  artwork: {
    width: 200,
    height: 200,
    borderRadius: 16,
    marginBottom: 8,
  },
  artworkPlaceholder: {
    width: 200,
    height: 200,
    borderRadius: 16,
    marginBottom: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  showLink: {
    fontSize: 14,
    fontWeight: '600',
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  meta: {
    fontSize: 13,
  },
  playButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 24,
    marginTop: 8,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  playButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  chapterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  chapterTime: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    width: 56,
  },
  chapterTitle: {
    flex: 1,
    fontSize: 14,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  linkText: {
    fontSize: 14,
    fontWeight: '500',
  },
  description: {
    fontSize: 14,
    lineHeight: 21,
  },
  errorText: {
    fontSize: 16,
  },
});

export default EpisodeScreen;
