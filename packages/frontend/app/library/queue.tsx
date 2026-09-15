import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQueueStore } from '@/stores/queueStore';
import { usePlayerStore } from '@/stores/playerStore';

export default function QueueScreen() {
  const { t } = useTranslation();
  const { queue, error, moveOccurrence, removeOccurrence, clearQueue, shuffle, repeat, toggleShuffle, cycleRepeat } = useQueueStore();
  const { playFromQueue, stop } = usePlayerStore();
  return <ScrollView className="flex-1 bg-background" contentContainerClassName="p-6 pb-36 gap-4" contentInsetAdjustmentBehavior="automatic">
    <Stack.Screen options={{ title: t('listener.queue') }} />
    <Text className="text-2xl font-bold text-foreground">{t('listener.queue')}</Text>
    <Text className="text-muted-foreground">{queue?.context?.name ?? t('listener.savedQueue')}</Text>
    <View className="flex-row flex-wrap gap-4">
      <Pressable accessibilityRole="button" accessibilityState={{ selected: shuffle === 'on' }} onPress={toggleShuffle}><Text className="text-primary">{t('listener.shuffle')} · {shuffle}</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={cycleRepeat}><Text className="text-primary">{t('player.repeat')} · {repeat}</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => { void stop(); void clearQueue(); }}><Text className="text-primary">{t('listener.clearQueue')}</Text></Pressable>
    </View>
    {error ? <Text accessibilityRole="alert" selectable className="text-destructive">{error}</Text> : null}
    {(queue?.tracks ?? []).map((track, index) => <View key={`${track.kind}:${track.id}:${index}`} className="flex-row items-center gap-3 py-3 border-b border-border">
      <Pressable accessibilityRole="button" accessibilityState={{ selected: index === queue?.current }} className="flex-1" onPress={() => void playFromQueue(index)}>
        <Text className={index === queue?.current ? 'text-primary font-semibold' : 'text-foreground'}>{index + 1}. {track.title}</Text>
        <Text className="text-muted-foreground">{track.artistName}</Text>
      </Pressable>
      <Pressable accessibilityLabel={t('listener.moveUp')} disabled={index === 0} className="p-3" onPress={() => void moveOccurrence(index, index - 1)}><Text className="text-primary">↑</Text></Pressable>
      <Pressable accessibilityLabel={t('listener.moveDown')} disabled={index === (queue?.tracks.length ?? 0) - 1} className="p-3" onPress={() => void moveOccurrence(index, index + 1)}><Text className="text-primary">↓</Text></Pressable>
      {index !== queue?.current ? <Pressable accessibilityLabel={t('listener.remove')} className="p-3" onPress={() => void removeOccurrence(index)}><Text className="text-primary">×</Text></Pressable> : null}
    </View>)}
  </ScrollView>;
}
