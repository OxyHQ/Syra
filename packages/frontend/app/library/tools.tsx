import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { Stack, useRouter, type Href } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import { useTranslation } from 'react-i18next';
import { useAuthGate } from '@/hooks/useAuthGate';
import { listenerTools } from '@/services/listener-tools-service';

const DESTINATIONS: { href: Href; title: string; description: string }[] = [
  { href: '/library/downloads', title: 'tools.downloads', description: 'tools.downloadsHint' },
  { href: '/library/import', title: 'tools.import', description: 'tools.importHint' },
  { href: '/library/mixes', title: 'tools.mixes', description: 'tools.mixesHint' },
  { href: '/library/curation', title: 'tools.curation', description: 'tools.curationHint' },
];

export default function LibraryToolsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const gate = useAuthGate();
  const { user } = useOxy();
  const queryClient = useQueryClient();
  const key = ['release-preference', user?.id] as const;
  const preference = useQuery({ queryKey: key, queryFn: listenerTools.releasePreference, enabled: gate.canUsePrivateApi });
  const update = useMutation({ mutationFn: listenerTools.setReleasePreference, onSuccess: (data) => queryClient.setQueryData(key, data) });
  return <ScrollView className="flex-1 bg-background" contentContainerClassName="p-6 pb-36 gap-5 w-full max-w-4xl mx-auto" contentInsetAdjustmentBehavior="automatic">
    <Stack.Screen options={{ title: t('tools.title') }} />
    <Text className="text-3xl font-bold text-foreground">{t('tools.title')}</Text>
    {DESTINATIONS.map((entry) => <Pressable key={entry.title} accessibilityRole="link" onPress={() => router.push(entry.href)} className="p-5 rounded-2xl bg-surface gap-2">
      <Text className="text-lg font-semibold text-foreground">{t(entry.title)}</Text>
      <Text className="text-muted-foreground">{t(entry.description)}</Text>
    </Pressable>)}
    <View className="p-5 rounded-2xl bg-surface gap-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-lg font-semibold text-foreground">{t('tools.releases')}</Text>
        {preference.isPending && gate.canUsePrivateApi ? <ActivityIndicator /> : null}
        {preference.data && gate.canUsePrivateApi ? <Switch accessibilityLabel={t('tools.releases')} value={preference.data.enabled} disabled={update.isPending} onValueChange={(enabled) => update.mutate(enabled)} /> : null}
      </View>
      <Text className="text-muted-foreground">{t('tools.releasesHint')}</Text>
      {gate.status === 'guest' ? <Text className="text-muted-foreground">{t('listener.signIn')}</Text> : null}
      {update.isError ? <Text accessibilityRole="alert" className="text-destructive">{t('tools.saveFailed')}</Text> : null}
      {preference.isError || gate.isTimedOut ? <Pressable accessibilityRole="button" onPress={() => { if (gate.canUsePrivateApi) void preference.refetch(); else gate.retry(); }}><Text className="text-primary">{t('listener.retry')}</Text></Pressable> : null}
    </View>
  </ScrollView>;
}
