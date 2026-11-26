import React, { useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { useLyrics } from '@/hooks/useLyrics';
import { usePlayerStore } from '@/stores/playerStore';
import { activeLyricLineIndex } from '@/utils/lyrics';
import { useTranslation } from 'react-i18next';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const SECONDS_TO_MS = 1000;

/** Number of skeleton lines shown while lyrics are loading. */
const LYRICS_SKELETON_LINE_COUNT = 8;

interface LyricsViewProps {
  /** Catalog track id — lyrics are fetched for this track. */
  trackId: string;
}

/**
 * Renders synced or plain lyrics for a track.
 *
 * - Loading: skeleton placeholder lines.
 * - No lyrics / error: friendly empty-state message.
 * - Synced lyrics: timed lines with the active line highlighted.
 * - Plain lyrics: scrollable text block.
 */
export const LyricsView: React.FC<LyricsViewProps> = React.memo(({ trackId }) => {
  const styles = useStyles();
  const { t } = useTranslation();
  const { lyrics, isLoading, isError, retry } = useLyrics(trackId);

  // currentTime is in seconds — convert to ms for the active-line computation.
  const currentTimeMs = usePlayerStore((state) =>
    state.currentTrack?.id === trackId ? state.currentTime * SECONDS_TO_MS : 0,
  );
  const isCurrent = usePlayerStore((state) => state.currentTrack?.id === trackId);
  const seek = usePlayerStore((state) => state.seek);

  const activeIndex = useMemo(() => {
    if (!isCurrent || !lyrics?.synced || !lyrics.lines.length) return -1;
    return activeLyricLineIndex(lyrics.lines, currentTimeMs);
  }, [lyrics, currentTimeMs, isCurrent]);

  if (isLoading) {
    return (
      <View style={styles.container}>
        {Array.from({ length: LYRICS_SKELETON_LINE_COUNT }).map((_, i) => (
          <Skeleton.Box key={i} width={i % 3 === 2 ? '55%' : '85%'} height={18} borderRadius={6} />
        ))}
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.stack}>
        <Text style={styles.mutedText}>{t('listener.lyricsFailed')}</Text>
        <Pressable accessibilityRole="button" onPress={retry}>
          <Text style={styles.text}>{t('listener.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  const plainText = lyrics?.plain?.trim()
    ? lyrics.plain
    : lyrics?.lines.map((line) => line.text).join('\n');
  if (!lyrics || !plainText?.trim()) {
    return (
      <View style={styles.centered}>
        <Text style={styles.mutedText2}>{t('lyrics.unavailable')}</Text>
      </View>
    );
  }

  if (lyrics.synced && lyrics.lines.length > 0) {
    return (
      <ScrollView
        key={trackId}
        style={styles.fill}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {lyrics.lines.map((line, index) => (
          <Pressable
            key={index}
            disabled={!isCurrent}
            accessibilityState={{ disabled: !isCurrent, selected: index === activeIndex }}
            accessibilityRole="button"
            accessibilityLabel={t('listener.seekLyric', { line: line.text })}
            onPress={() => void seek(line.timeMs / SECONDS_TO_MS)}
          >
            <Text
              selectable={!isCurrent}
              className={
                index === activeIndex
                  ? 'text-lg font-semibold text-primary leading-relaxed'
                  : 'text-base text-muted-foreground leading-relaxed'
              }
            >
              {line.text}
            </Text>
          </Pressable>
        ))}
        <Text style={styles.mutedText3}>
          {t('listener.lyricsSource', { source: lyrics.source })}
        </Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      key={trackId}
      style={styles.fill}
      contentContainerStyle={styles.content2}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.text2}>{plainText}</Text>
      <Text style={styles.mutedText4}>{t('listener.lyricsSource', { source: lyrics.source })}</Text>
    </ScrollView>
  );
});

LyricsView.displayName = 'LyricsView';

const useStyles = createTokenStyles((t) => ({
  container: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 16,
  },
  stack: { gap: 12, padding: 24 },
  mutedText: { color: t.mutedForeground },
  text: { color: t.primary },
  centered: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  mutedText2: {
    textAlign: 'center',
    fontSize: 18,
    fontWeight: 500,
    color: t.mutedForeground,
    lineHeight: 28,
  },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  content: { gap: 8, paddingHorizontal: 24, paddingVertical: 16 },
  mutedText3: { fontSize: 14, color: t.mutedForeground, lineHeight: 20 },
  content2: { paddingHorizontal: 24, paddingVertical: 16 },
  text2: { fontSize: 16, color: t.foreground, lineHeight: 26 },
  mutedText4: { marginTop: 16, fontSize: 14, color: t.mutedForeground, lineHeight: 20 },
}));
