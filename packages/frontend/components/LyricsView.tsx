import React, { useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { useLyrics } from '@/hooks/useLyrics';
import { usePlayerStore } from '@/stores/playerStore';
import { activeLyricLineIndex } from '@/utils/lyrics';
import { useTranslation } from 'react-i18next';

const SECONDS_TO_MS = 1000;

/** Number of skeleton lines shown while lyrics are loading. */
const LYRICS_SKELETON_LINE_COUNT = 8;

interface LyricsViewProps {
  /** Catalog track ObjectId — lyrics are fetched for this track. */
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
  const { t } = useTranslation();
  const { lyrics, isLoading, isError, retry } = useLyrics(trackId);

  // currentTime is in seconds — convert to ms for the active-line computation.
  const currentTimeMs = usePlayerStore((state) => state.currentTrack?.id === trackId ? state.currentTime * SECONDS_TO_MS : 0);
  const isCurrent = usePlayerStore((state) => state.currentTrack?.id === trackId);
  const seek = usePlayerStore((state) => state.seek);

  const activeIndex = useMemo(() => {
    if (!lyrics?.synced || !lyrics.lines.length) return -1;
    return activeLyricLineIndex(lyrics.lines, currentTimeMs);
  }, [lyrics, currentTimeMs]);

  if (isLoading) {
    return (
      <View className="flex-1 px-6 py-4 gap-3">
        {Array.from({ length: LYRICS_SKELETON_LINE_COUNT }).map((_, i) => (
          <Skeleton.Box
            key={i}
            width={i % 3 === 2 ? '55%' : '85%'}
            height={18}
            borderRadius={6}
          />
        ))}
      </View>
    );
  }

  if (isError) {
    return <View className="p-6 gap-3"><Text className="text-muted-foreground">{t('listener.lyricsFailed')}</Text><Pressable accessibilityRole="button" onPress={retry}><Text className="text-primary">{t('listener.retry')}</Text></Pressable></View>;
  }

  if (!lyrics) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-lg font-medium text-muted-foreground text-center">
          {t('lyrics.unavailable')}
        </Text>
      </View>
    );
  }

  if (lyrics.synced && lyrics.lines.length > 0) {
    return (
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-6 py-4 gap-2"
        showsVerticalScrollIndicator={false}
      >
        {lyrics.lines.map((line, index) => (
          <Pressable key={index} disabled={!isCurrent} accessibilityRole="button" accessibilityLabel={t('listener.seekLyric', { line: line.text })} onPress={() => void seek(line.timeMs / SECONDS_TO_MS)}>
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
        <Text className="text-sm text-muted-foreground">{t('listener.lyricsSource', { source: lyrics.source })}</Text>
      </ScrollView>
    );
  }

  // Plain text fallback — join lines or use the plain field.
  const plainText =
    lyrics.plain ??
    lyrics.lines.map((l) => l.text).join('\n');

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="px-6 py-4"
      showsVerticalScrollIndicator={false}
    >
      <Text className="text-base text-foreground leading-relaxed">
        {plainText}
      </Text>
      <Text className="text-sm text-muted-foreground mt-4">{t('listener.lyricsSource', { source: lyrics.source })}</Text>
    </ScrollView>
  );
});

LyricsView.displayName = 'LyricsView';
