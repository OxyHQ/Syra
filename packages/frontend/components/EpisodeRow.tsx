import React, { useMemo } from 'react';
import { StyleSheet, View, Text, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useTheme } from '@oxyhq/bloom/theme';
import type { Episode } from '@syra/shared-types';
import { resolvePodcastArtwork } from '@/utils/pickImage';
import { formatEpisodeDuration, formatPubDate, formatRemaining } from '@/utils/podcastFormat';
import type { EpisodeProgressSnapshot } from '@/hooks/usePodcasts';
import { webViewStyle } from '@/utils/webStyles';

interface EpisodeRowProps {
  episode: Episode;
  /** Saved progress for this episode (drives the progress bar + played dot). */
  progress?: EpisodeProgressSnapshot;
  /** Whether this episode is the one currently loaded in the player. */
  isCurrent?: boolean;
  /** Whether the player is actively playing this episode. */
  isPlaying?: boolean;
  onPress: () => void;
  onPlayPress: () => void;
  /** Hide the show artwork (e.g. when already inside that show's screen). */
  hideArtwork?: boolean;
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
  hideArtwork = false,
}) => {
  const theme = useTheme();
  const imageUri = useMemo(
    () => resolvePodcastArtwork(episode, 'thumbnail'),
    [episode],
  );

  const completed = progress?.completed ?? false;
  const hasProgress = !completed && (progress?.progressSec ?? 0) > 0 && (progress?.durationSec ?? 0) > 0;
  const progressPercent = hasProgress && progress
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
      onPress={onPress}
      style={[
        styles.row,
        isCurrent && { backgroundColor: theme.colors.backgroundSecondary + '40' },
        ...Platform.select({ web: [webViewStyle({ cursor: 'pointer' })], default: [] }),
      ]}
    >
      {!hideArtwork && (
        imageUri ? (
          <Image source={{ uri: imageUri }} style={styles.artwork} contentFit="cover" />
        ) : (
          <View style={[styles.artworkPlaceholder, { backgroundColor: theme.colors.backgroundTertiary }]}>
            <Ionicons name="mic" size={20} color={theme.colors.textSecondary} />
          </View>
        )
      )}

      <View style={styles.body}>
        <Text
          style={[styles.title, { color: isCurrent ? theme.colors.primary : theme.colors.text }]}
          numberOfLines={2}
        >
          {episode.title}
        </Text>

        <View style={styles.metaRow}>
          {completed && (
            <View style={[styles.playedDot, { backgroundColor: theme.colors.primary }]} />
          )}
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {metaLabel}
          </Text>
        </View>

        {hasProgress && (
          <View style={[styles.progressTrack, { backgroundColor: theme.colors.border }]}>
            <View
              style={[styles.progressFill, { backgroundColor: theme.colors.primary, width: `${progressPercent}%` }]}
            />
          </View>
        )}
      </View>

      <Pressable
        onPress={(event) => {
          event?.stopPropagation?.();
          onPlayPress();
        }}
        style={[styles.playButton, { borderColor: theme.colors.border }]}
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause episode' : 'Play episode'}
      >
        <Ionicons
          name={isPlaying ? 'pause' : 'play'}
          size={20}
          color={theme.colors.text}
        />
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
        cursor: 'pointer',
      },
    }),
  },
});
