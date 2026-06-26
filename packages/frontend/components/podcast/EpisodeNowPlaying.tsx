import React from 'react';
import { StyleSheet, View, Text, ScrollView, Pressable, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { usePlayerStore } from '@/stores/playerStore';
import { useEpisodeChapters } from '@/hooks/usePodcasts';
import { resolvePodcastImageUri } from '@/utils/podcastImages';
import { formatDuration } from '@/utils/musicUtils';
import { SpeedPill, SkipButton } from './PodcastTransportControls';

/**
 * Now-playing view for a podcast episode (desktop right rail). Shows artwork,
 * the show/title, podcast transport (skip ±15/30s, play/pause, speed) and the
 * Podcasting 2.0 chapter list when present (tap a chapter to seek).
 */
export const EpisodeNowPlaying: React.FC = () => {
  const theme = useTheme();
  const router = useRouter();

  const episode = usePlayerStore((s) => s.currentEpisode);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const pause = usePlayerStore((s) => s.pause);
  const resume = usePlayerStore((s) => s.resume);
  const seek = usePlayerStore((s) => s.seek);

  const chaptersQuery = useEpisodeChapters(episode?.chapters?.url);

  if (!episode) {
    return null;
  }

  const artwork = resolvePodcastImageUri(episode, 'hero');
  const chapters = chaptersQuery.data ?? [];
  const activeChapterIndex = chapters.reduce(
    (active, chapter, index) => (currentTime >= chapter.startTime ? index : active),
    -1,
  );

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.artworkWrap}>
        {artwork ? (
          <ExpoImage source={{ uri: artwork }} style={styles.artwork} contentFit="cover" />
        ) : (
          <View style={[styles.artworkPlaceholder, { backgroundColor: theme.colors.backgroundTertiary }]}>
            <Ionicons name="mic" size={64} color={theme.colors.textSecondary} />
          </View>
        )}
        <LinearGradient colors={['transparent', 'rgba(0,0,0,0.55)']} style={styles.artworkGradient} />
      </View>

      <Pressable
        onPress={() => router.push({ pathname: '/podcasts/[id]', params: { id: episode.podcastId } })}
        accessibilityRole="link"
      >
        <Text style={[styles.show, { color: theme.colors.primary }]} numberOfLines={1}>
          {episode.podcastTitle}
        </Text>
      </Pressable>
      <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={3}>
        {episode.title}
      </Text>

      {/* Transport */}
      <View style={styles.transport}>
        <SkipButton direction="back" seconds={15} size={26} />
        <Pressable
          onPress={() => (isPlaying ? pause() : resume())}
          style={[styles.playButton, { backgroundColor: theme.colors.primary }]}
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
        >
          <MaterialCommunityIcons
            name={isPlaying ? 'pause' : 'play'}
            size={28}
            color={theme.colors.primaryForeground}
          />
        </Pressable>
        <SkipButton direction="forward" seconds={30} size={26} />
      </View>
      <View style={styles.speedRow}>
        <SpeedPill />
      </View>

      {/* Chapters */}
      {chapters.length > 0 && (
        <View style={[styles.card, { backgroundColor: theme.colors.backgroundTertiary }]}>
          <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Chapters</Text>
          {chapters.map((chapter, index) => {
            const isActive = index === activeChapterIndex;
            return (
              <Pressable
                key={`${chapter.startTime}-${index}`}
                onPress={() => seek(chapter.startTime)}
                style={styles.chapterRow}
              >
                <Text style={[styles.chapterTime, { color: isActive ? theme.colors.primary : theme.colors.textSecondary }]}>
                  {formatDuration(chapter.startTime)}
                </Text>
                <Text
                  style={[styles.chapterTitle, { color: isActive ? theme.colors.primary : theme.colors.text }]}
                  numberOfLines={1}
                >
                  {chapter.title ?? 'Untitled chapter'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 80,
    gap: 8,
  },
  artworkWrap: {
    position: 'relative',
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 8,
  },
  artwork: {
    width: '100%',
    aspectRatio: 1,
  },
  artworkPlaceholder: {
    width: '100%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artworkGradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '40%',
  },
  show: {
    fontSize: 14,
    fontWeight: '600',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    marginTop: 12,
  },
  playButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  speedRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 4,
  },
  card: {
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
    gap: 4,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  chapterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  chapterTime: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    width: 52,
  },
  chapterTitle: {
    flex: 1,
    fontSize: 14,
  },
});
