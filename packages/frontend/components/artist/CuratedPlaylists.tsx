import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { Playlist } from '@syra/shared-types';
import { MediaCard } from '@/components/MediaCard';
import { ResponsiveGrid } from '@/components/ResponsiveGrid';
import { usePlayEntity } from '@/hooks/usePlayEntity';

export function CuratedPlaylists({ items, isError, onRetry }: { items: Playlist[]; isError: boolean; onRetry: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { playPlaylist } = usePlayEntity();
  if (isError) return <View className="px-6 py-4 gap-2"><Text className="text-muted-foreground">{t('tools.curatedUnavailable')}</Text>
    <Pressable accessibilityRole="button" onPress={onRetry}><Text className="text-primary">{t('listener.retry')}</Text></Pressable></View>;
  if (!items.length) return null;
  return <View className="px-6 py-4 gap-4">
    <Text className="text-2xl font-bold text-foreground">{t('tools.selectedByArtist')}</Text>
    <ResponsiveGrid minItemWidth={160} gap={12}>{items.map((playlist) => <MediaCard key={playlist.id} type="playlist" title={playlist.name}
      imageUri={playlist.coverArt} imageSizes={playlist.coverArtSizes} subtitle={playlist.ownerUsername} primaryColor={playlist.primaryColor}
      onPress={() => router.push({ pathname: '/playlist/[id]', params: { id: playlist.id } })} onPlayPress={() => void playPlaylist(playlist.id, playlist.name)} />)}</ResponsiveGrid>
  </View>;
}
