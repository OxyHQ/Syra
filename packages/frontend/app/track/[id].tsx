import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Image } from 'expo-image';
import { musicService } from '@/services/musicService';
import { useAuthGate } from '@/hooks/useAuthGate';
import { usePlayerStore } from '@/stores/playerStore';
import { TrackCredits } from '@/components/TrackCredits';
import { LyricsView } from '@/components/LyricsView';
import { TrackArtistLine } from '@/components/TrackArtistLine';
import { TrackActionsSheet } from '@/components/playlist/TrackActionsSheet';
import { pickCatalogImageUrl } from '@/utils/pickImage';
import { shareMedia } from '@/utils/share-media';
import SEO from '@/components/SEO';

export default function TrackScreen() {
  const { id, t: timestamp } = useLocalSearchParams<{ id: string; t?: string }>();
  const { t } = useTranslation();
  const gate = useAuthGate();
  const [showActions, setShowActions] = React.useState(false);
  const query = useQuery({ queryKey: ['track-detail', id, gate.catalogIdentity], queryFn: () => musicService.getTrackById(id), enabled: Boolean(id) && gate.isResolved });
  const track = query.data;
  const playing = usePlayerStore((state) => state.currentTrack?.id === id && state.isPlaying);
  const handlePlay = async () => {
    if (!track) return;
    const player = usePlayerStore.getState();
    if (player.currentTrack?.id === id) {
      await (player.isPlaying ? player.pause() : player.resume());
      return;
    }
    await player.playTrack(track, { type: 'track', id, name: track.title });
    const position = Number(timestamp);
    if (Number.isFinite(position) && position > 0 && usePlayerStore.getState().currentTrack?.id === id) {
      await usePlayerStore.getState().seek(Math.min(position, Math.max(0, track.duration - 1)));
    }
  };
  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="p-6 gap-5 pb-36" contentInsetAdjustmentBehavior="automatic">
      <Stack.Screen options={{ title: track?.title ?? t('listener.track') }} />
      {gate.isResolving || query.isLoading ? <ActivityIndicator /> : null}
      {query.isError || gate.isTimedOut ? <Pressable onPress={() => { gate.retry(); void query.refetch(); }}><Text className="text-foreground">{t('listener.retry')}</Text></Pressable> : null}
      {track ? <>
        <SEO title={track.title} description={track.artistName} image={pickCatalogImageUrl(track.images, track.coverArt, 'detailArtwork', track.coverArtSizes)} />
        <Image source={{ uri: pickCatalogImageUrl(track.images, track.coverArt, 'detailArtwork', track.coverArtSizes) }} className="w-64 h-64 rounded-2xl" contentFit="cover" />
        <Text selectable className="text-3xl font-bold text-foreground">{track.title}</Text>
        <TrackArtistLine track={track} className="text-muted-foreground text-lg" />
        <View className="flex-row flex-wrap gap-3">
          <Pressable onPress={() => void handlePlay()} accessibilityRole="button" className="rounded-full bg-primary px-6 py-3"><Text className="text-primary-foreground font-semibold">{t(playing ? 'listener.pause' : 'listener.play')}</Text></Pressable>
          <Pressable onPress={() => setShowActions(true)} accessibilityRole="button" className="rounded-full bg-surface px-6 py-3"><Text className="text-foreground">{t('listener.actions')}</Text></Pressable>
          <Pressable onPress={() => void shareMedia('track', id, track.title)} accessibilityRole="button" className="rounded-full bg-surface px-6 py-3"><Text className="text-foreground">{t('listener.share')}</Text></Pressable>
        </View>
        <TrackCredits track={track} />
        <Text className="text-xl font-semibold text-foreground">{t('listener.lyrics')}</Text>
        <LyricsView trackId={id} />
        <TrackActionsSheet visible={showActions} onClose={() => setShowActions(false)} track={track} />
      </> : null}
    </ScrollView>
  );
}
