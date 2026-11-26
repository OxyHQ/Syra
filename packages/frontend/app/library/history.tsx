import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text } from 'react-native';
import { Stack } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { useAuthGate } from '@/hooks/useAuthGate';
import { libraryService } from '@/services/libraryService';
import { usePlayerStore } from '@/stores/playerStore';
import { TrackRow } from '@/components/TrackRow';
import { createTokenStyles } from '@oxy.so/bloom/theme';

export default function ListeningHistoryScreen() {
  const styles = useStyles();
  const { t } = useTranslation();
  const gate = useAuthGate();
  const { user } = useOxy();
  const query = useQuery({
    queryKey: ['listening-history', user?.id],
    queryFn: () => libraryService.getRecentlyPlayed(50),
    enabled: gate.canUsePrivateApi,
  });
  const tracks = query.data?.tracks ?? [];
  const currentId = usePlayerStore((state) => state.currentTrack?.id);
  const playing = usePlayerStore((state) => state.isPlaying);
  const playTrackList = usePlayerStore((state) => state.playTrackList);
  return (
    <ScrollView
      style={styles.surface}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={{ title: t('listener.history') }} />
      <Text style={styles.title}>{t('listener.history')}</Text>
      {gate.isResolving || (gate.canUsePrivateApi && query.isPending) ? (
        <ActivityIndicator />
      ) : null}
      {gate.status === 'guest' ? (
        <Text style={styles.mutedText}>{t('listener.signIn')}</Text>
      ) : null}
      {query.isError || gate.isTimedOut ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            if (gate.canUsePrivateApi) void query.refetch();
            else gate.retry();
          }}
        >
          <Text style={styles.text}>{t('listener.retry')}</Text>
        </Pressable>
      ) : null}
      {query.isSuccess && !tracks.length ? (
        <Text style={styles.mutedText}>{t('listener.historyEmpty')}</Text>
      ) : null}
      {tracks.map((track, index) => (
        <TrackRow
          key={track.id}
          track={track}
          index={index}
          isCurrentTrack={track.id === currentId}
          isTrackPlaying={track.id === currentId && playing}
          onPress={() =>
            void playTrackList(tracks, index, { type: 'library', name: t('listener.history') })
          }
          onPlayPress={() =>
            void playTrackList(tracks, index, { type: 'library', name: t('listener.history') })
          }
        />
      ))}
    </ScrollView>
  );
}

const useStyles = createTokenStyles((t) => ({
  surface: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', backgroundColor: t.background },
  content: { gap: 12, padding: 24, paddingBottom: 144 },
  title: { fontSize: 24, fontWeight: 700, color: t.foreground, lineHeight: 32 },
  mutedText: { color: t.mutedForeground },
  text: { color: t.primary },
}));
