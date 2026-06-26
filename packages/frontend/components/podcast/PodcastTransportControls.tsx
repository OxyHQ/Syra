import React from 'react';
import { Pressable, StyleSheet, Text, Platform } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { usePlayerStore } from '@/stores/playerStore';

/** Selectable podcast speeds, cycled by the speed pill. */
export const PODCAST_PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2, 0.75] as const;

function nextRate(current: number): number {
  const index = PODCAST_PLAYBACK_RATES.findIndex((rate) => rate === current);
  const next = PODCAST_PLAYBACK_RATES[(index + 1) % PODCAST_PLAYBACK_RATES.length];
  return next ?? 1;
}

function formatRate(rate: number): string {
  return `${rate}×`;
}

interface SpeedPillProps {
  size?: 'sm' | 'md';
  tint?: string;
}

/**
 * Playback-speed pill. Tapping cycles through {@link PODCAST_PLAYBACK_RATES}.
 */
export const SpeedPill: React.FC<SpeedPillProps> = ({ size = 'md', tint }) => {
  const theme = useTheme();
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const setPlaybackRate = usePlayerStore((s) => s.setPlaybackRate);
  const color = tint ?? theme.colors.textSecondary;

  return (
    <Pressable
      onPress={() => setPlaybackRate(nextRate(playbackRate))}
      style={[styles.pill, size === 'sm' && styles.pillSm, { borderColor: color }]}
      accessibilityRole="button"
      accessibilityLabel={`Playback speed ${formatRate(playbackRate)}`}
    >
      <Text style={[styles.pillText, size === 'sm' && styles.pillTextSm, { color }]}>
        {formatRate(playbackRate)}
      </Text>
    </Pressable>
  );
};

type SkipDirection = 'back' | 'forward';

interface SkipButtonProps {
  direction: SkipDirection;
  /** Seconds to skip; conventionally 15 back / 30 forward. */
  seconds?: number;
  size?: number;
  tint?: string;
}

const SKIP_ICONS: Record<SkipDirection, Record<number, keyof typeof MaterialCommunityIcons.glyphMap>> = {
  back: { 15: 'rewind-15', 30: 'rewind-30' },
  forward: { 15: 'fast-forward-15', 30: 'fast-forward-30' },
};

/**
 * Relative skip control (±15s / ±30s) wired to the player store's `skipBy`.
 */
export const SkipButton: React.FC<SkipButtonProps> = ({ direction, seconds = direction === 'back' ? 15 : 30, size = 24, tint }) => {
  const theme = useTheme();
  const skipBy = usePlayerStore((s) => s.skipBy);
  const icon = SKIP_ICONS[direction][seconds] ?? (direction === 'back' ? 'rewind-15' : 'fast-forward-30');
  const delta = direction === 'back' ? -seconds : seconds;

  return (
    <Pressable
      onPress={() => skipBy(delta)}
      style={styles.skipButton}
      accessibilityRole="button"
      accessibilityLabel={`${direction === 'back' ? 'Rewind' : 'Forward'} ${seconds} seconds`}
    >
      <MaterialCommunityIcons name={icon} size={size} color={tint ?? theme.colors.text} />
    </Pressable>
  );
};

const styles = StyleSheet.create({
  pill: {
    minWidth: 40,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  pillSm: {
    minWidth: 34,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
  },
  pillText: {
    fontSize: 13,
    fontWeight: '700',
  },
  pillTextSm: {
    fontSize: 11,
  },
  skipButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
});
