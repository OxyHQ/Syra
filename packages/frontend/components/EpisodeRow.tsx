import React, { useMemo } from 'react';
import { StyleSheet, View, Text, Pressable, Platform } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { useTheme } from '@oxy.so/bloom/theme';
import type { Episode } from '@syra/shared-types';
import { resolvePodcastArtwork } from '@/utils/pickImage';
import { formatEpisodeDuration, formatPubDate, formatRemaining } from '@/utils/podcastFormat';
import type { EpisodeProgressSnapshot } from '@/hooks/usePodcasts';
import { usePlayerStore } from '@/stores/playerStore';
import { webViewStyle } from '@/utils/webStyles';
import { createTokenStyles } from '@oxy.so/bloom/theme';

interface EpisodeRowProps {
  episode: Episode;
  /** Saved progress for this episode (drives the progress bar + played dot). */
  progress?: EpisodeProgressSnapshot;
  /** Whether this episode is the one currently loaded in the player. */
  isCurrent?: boolean;
  /** Whether the player is actively playing this episode. */
  isPlaying?: boolean;
  onPress: () => void;
  /**
   * Starts this episode in the caller's queue context. Only invoked when the
   * episode is NOT the one already loaded in the player — a loaded episode is
   * toggled by the row itself, so this never restarts what is already playing.
   */
  onPlayPress: () => void;
}

/**
 * Episode list row — artwork, title, publish date + duration / remaining-time,
 * a progress bar (with a played dot when finished), and a play/pause control.
 */
const EpisodeRowComponent: React.FC<EpisodeRowProps> = ({
  episode,
  progress,
  isCurrent = false,
  isPlaying = false,
  onPress,
  onPlayPress,
}) => {
  const themed = useThemedStyles();
  const theme = useTheme();
  const pause = usePlayerStore((state) => state.pause);
  const resume = usePlayerStore((state) => state.resume);
  const imageUri = useMemo(() => resolvePodcastArtwork(episode, 'thumbnail'), [episode]);

  /**
   * The one contract for this control, so its icon and its action can never
   * disagree — pressing pause pauses, and pressing play on the loaded episode
   * resumes instead of restarting it from the beginning. Owning it here is what
   * makes every screen behave the same; callers only start episodes that are
   * not already loaded.
   */
  const handlePlayPress = () => {
    if (!isCurrent) {
      onPlayPress();
      return;
    }
    if (isPlaying) {
      void pause();
      return;
    }
    void resume();
  };

  const completed = progress?.completed ?? false;
  const hasProgress =
    !completed && (progress?.progressSec ?? 0) > 0 && (progress?.durationSec ?? 0) > 0;
  const progressPercent =
    hasProgress && progress
      ? Math.min(100, (progress.progressSec / progress.durationSec) * 100)
      : 0;

  const metaLabel = useMemo(() => {
    const parts: string[] = [];
    const date = formatPubDate(episode.pubDate);
    if (date) {
      parts.push(date);
    }
    if (completed) {
      parts.push('Played');
    } else if (hasProgress && progress) {
      parts.push(formatRemaining(progress.progressSec, progress.durationSec));
    } else {
      const duration = formatEpisodeDuration(episode.duration);
      if (duration) {
        parts.push(duration);
      }
    }
    return parts.join(' • ');
  }, [episode.pubDate, episode.duration, completed, hasProgress, progress]);

  return (
    <Pressable
      className={isCurrent ? 'bg-surface/25' : undefined}
      onPress={onPress}
      style={[
        styles.row,
        undefined,
        ...Platform.select({ web: [webViewStyle({ cursor: 'pointer' as const })], default: [] }),
      ]}
    >
      {imageUri ? (
        <Image source={{ uri: imageUri }} style={styles.artwork} contentFit="cover" />
      ) : (
        <View style={[themed.surface, styles.artworkPlaceholder]}>
          <Ionicons name="mic" size={20} color={theme.colors.textSecondary} />
        </View>
      )}

      <View style={styles.body}>
        <Text
          style={[styles.title, { color: isCurrent ? theme.colors.primary : theme.colors.text }]}
          numberOfLines={2}
        >
          {episode.title}
        </Text>

        <View style={styles.metaRow}>
          {completed && <View style={[themed.surface2, styles.playedDot]} />}
          <Text style={[themed.mutedText, styles.meta]} numberOfLines={1}>
            {metaLabel}
          </Text>
        </View>

        {hasProgress && (
          <View style={[themed.surface3, styles.progressTrack]}>
            <View
              style={[themed.surface2, styles.progressFill, { width: `${progressPercent}%` }]}
            />
          </View>
        )}
      </View>

      <Pressable
        onPress={(event) => {
          event?.stopPropagation?.();
          handlePlayPress();
        }}
        style={[themed.container, styles.playButton]}
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause episode' : 'Play episode'}
      >
        <Ionicons name={isPlaying ? 'pause' : 'play'} size={20} color={theme.colors.text} />
      </Pressable>
    </Pressable>
  );
};

export const EpisodeRow = React.memo(EpisodeRowComponent);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  artwork: {
    width: 56,
    height: 56,
    borderRadius: 8,
  },
  artworkPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 19,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  playedDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  meta: {
    flex: 1,
    fontSize: 12,
  },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  playButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer' as const,
      },
    }),
  },
});

const useThemedStyles = createTokenStyles((t) => ({
  surface: { backgroundColor: t.popover },
  surface2: { backgroundColor: t.primary },
  mutedText: { color: t.mutedForeground },
  surface3: { backgroundColor: t.border },
  container: { borderColor: t.border },
}));
