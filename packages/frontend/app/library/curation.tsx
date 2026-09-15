import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import { useTranslation } from 'react-i18next';
import type { Playlist } from '@syra/shared-types';
import { listenerTools } from '@/services/listener-tools-service';
import { musicService } from '@/services/musicService';
import { useAuthGate } from '@/hooks/useAuthGate';

export default function ArtistCurationScreen() {
  const { t } = useTranslation();
  const { user } = useOxy();
  const gate = useAuthGate();
  const artist = useQuery({ queryKey: ['owned-artist', user?.id], queryFn: listenerTools.ownedArtist, enabled: gate.canUsePrivateApi });
  const choices = useQuery({ queryKey: ['curation-choices', user?.id], queryFn: musicService.getUserPlaylists, enabled: gate.canUsePrivateApi });
  const artistId = artist.data?.id;
  const selections = useQuery({ queryKey: ['artist-curated', artistId], queryFn: () => listenerTools.curated(artistId ?? ''), enabled: !!artistId && gate.canUsePrivateApi });
  return <ScrollView className="flex-1 bg-background" contentContainerClassName="p-6 pb-36 gap-4 w-full max-w-4xl mx-auto" contentInsetAdjustmentBehavior="automatic">
    <Stack.Screen options={{ title: t('tools.curation') }} />
    <Text className="text-3xl font-bold text-foreground">{t('tools.curation')}</Text>
    <Text className="text-muted-foreground">{t('tools.curationHint')}</Text>
    {gate.isResolving || (gate.canUsePrivateApi && (artist.isPending || choices.isPending || (artistId && selections.isPending))) ? <ActivityIndicator /> : null}
    {gate.status === 'guest' ? <Text className="text-muted-foreground">{t('listener.signIn')}</Text> : null}
    {gate.isTimedOut || artist.isError || choices.isError || selections.isError ? <Pressable accessibilityRole="button" onPress={() => {
      if (!gate.canUsePrivateApi) gate.retry(); else { void artist.refetch(); void choices.refetch(); if (artistId) void selections.refetch(); }
    }}><Text className="text-primary">{t('listener.retry')}</Text></Pressable> : null}
    {gate.canUsePrivateApi && artist.isSuccess && !artist.data ? <Text className="text-muted-foreground">{t('tools.artistRequired')}</Text> : null}
    {gate.canUsePrivateApi && artistId && choices.data && selections.data ? <CurationEditor key={`${user?.id}:${artistId}`} artistId={artistId}
      choices={choices.data.playlists.filter((playlist) => playlist.visibility === 'public' && playlist.ownerOxyUserId === user?.id)} initialSelection={selections.data.map((playlist) => playlist.id)} /> : null}
  </ScrollView>;
}

function CurationEditor({ artistId, choices, initialSelection }: { artistId: string; choices: Playlist[]; initialSelection: string[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(initialSelection);
  const save = useMutation({ mutationFn: () => listenerTools.saveCurated(artistId, selected), onSuccess: (data) => {
    queryClient.setQueryData(['artist-curated', artistId], data);
  } });
  const handleToggle = (id: string) => {
    save.reset();
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 10 ? [...current, id] : current);
  };
  const handleMove = (index: number, offset: number) => {
    setSelected((current) => {
      const next = [...current];
      const target = index + offset;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    save.reset();
  };
  return <View className="gap-4">
    <Text className="text-foreground">{t('tools.curatedCount', { count: selected.length })}</Text>
    {!choices.length ? <Text className="text-muted-foreground">{t('tools.noPublicPlaylists')}</Text> : null}
    {choices.map((playlist) => <Pressable key={playlist.id} accessibilityRole="checkbox" accessibilityState={{ checked: selected.includes(playlist.id) }}
      disabled={save.isPending || (!selected.includes(playlist.id) && selected.length >= 10)} onPress={() => handleToggle(playlist.id)} className="p-4 rounded-xl bg-surface flex-row gap-3">
      <Text className="text-primary">{selected.includes(playlist.id) ? '✓' : '○'}</Text><Text className="flex-1 text-foreground">{playlist.name}</Text>
    </Pressable>)}
    {selected.map((id, index) => <View key={id} className="flex-row items-center gap-3 py-2">
      <Text className="flex-1 text-foreground">{index + 1}. {choices.find((item) => item.id === id)?.name ?? t('tools.unavailablePlaylist')}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t('tools.moveUp')} disabled={save.isPending || index === 0} onPress={() => handleMove(index, -1)} className="p-3"><Text className="text-primary">↑</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t('tools.moveDown')} disabled={save.isPending || index === selected.length - 1} onPress={() => handleMove(index, 1)} className="p-3"><Text className="text-primary">↓</Text></Pressable>
    </View>)}
    {save.isPending ? <ActivityIndicator /> : null}
    {save.isError ? <Text accessibilityRole="alert" className="text-destructive">{t('tools.saveFailed')}</Text> : null}
    {save.isSuccess ? <Text accessibilityRole="alert" className="text-primary">{t('tools.saved')}</Text> : null}
    <Pressable accessibilityRole="button" disabled={save.isPending} onPress={() => save.mutate()} className="p-4 rounded-full bg-primary"><Text className="text-center font-semibold text-primary-foreground">{t('tools.save')}</Text></Pressable>
  </View>;
}
