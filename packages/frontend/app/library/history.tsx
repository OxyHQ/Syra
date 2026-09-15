import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text } from 'react-native';
import { Stack } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import { useTranslation } from 'react-i18next';
import { useAuthGate } from '@/hooks/useAuthGate';
import { libraryService } from '@/services/libraryService';
import { usePlayerStore } from '@/stores/playerStore';
import { TrackRow } from '@/components/TrackRow';

export default function ListeningHistoryScreen() {
  const { t } = useTranslation();
  const gate = useAuthGate();
  const { user } = useOxy();
  const query = useQuery({ queryKey: ['listening-history', user?.id], queryFn: () => libraryService.getRecentlyPlayed(50), enabled: gate.canUsePrivateApi });
  const tracks = query.data?.tracks ?? [];
  const currentId = usePlayerStore((state) => state.currentTrack?.id);
  const playing = usePlayerStore((state) => state.isPlaying);
  const playTrackList = usePlayerStore((state) => state.playTrackList);
  return <ScrollView className="flex-1 bg-background" contentContainerClassName="p-6 pb-36 gap-3" contentInsetAdjustmentBehavior="automatic">
    <Stack.Screen options={{ title: t('listener.history') }} />
    <Text className="text-2xl font-bold text-foreground">{t('listener.history')}</Text>
    {gate.isResolving || (gate.canUsePrivateApi && query.isPending) ? <ActivityIndicator /> : null}
    {gate.status === 'guest' ? <Text className="text-muted-foreground">{t('listener.signIn')}</Text> : null}
    {query.isError || gate.isTimedOut ? <Pressable accessibilityRole="button" onPress={() => { if (gate.canUsePrivateApi) void query.refetch(); else gate.retry(); }}><Text className="text-primary">{t('listener.retry')}</Text></Pressable> : null}
    {query.isSuccess && !tracks.length ? <Text className="text-muted-foreground">{t('listener.historyEmpty')}</Text> : null}
    {tracks.map((track, index) => <TrackRow key={track.id} track={track} index={index} isCurrentTrack={track.id === currentId} isTrackPlaying={track.id === currentId && playing} onPress={() => void playTrackList(tracks, index, { type: 'library', name: t('listener.history') })} onPlayPress={() => void playTrackList(tracks, index, { type: 'library', name: t('listener.history') })} />)}
  </ScrollView>;
}
