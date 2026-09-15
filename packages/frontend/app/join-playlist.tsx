import React from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { playlistSharingService } from '@/services/playlistSharingService';

export default function JoinPlaylist() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { canUsePrivateApi, openAccountDialog } = useOxy();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const join = useMutation({
    mutationFn: async () => {
      if (!canUsePrivateApi || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error(t('collaboration.invalidInvite'));
      return playlistSharingService.join(token);
    },
    onSuccess: async ({ playlistId }) => {
      await queryClient.invalidateQueries({ queryKey: ['library'] });
      await queryClient.invalidateQueries({ queryKey: ['playlist', playlistId] });
      router.replace({ pathname: '/playlist/[id]', params: { id: playlistId } });
    },
  });
  return <ScrollView className="bg-surface" contentContainerClassName="p-6 gap-5" contentInsetAdjustmentBehavior="automatic">
    <Stack.Screen options={{ title: t('collaboration.join') }} />
    <Text className="text-foreground text-2xl font-semibold">{t('collaboration.join')}</Text>
    <Text className="text-muted-foreground">{t('collaboration.consent')}</Text>
    {!canUsePrivateApi ? <Pressable accessibilityRole="button" onPress={() => openAccountDialog('signin')}><Text className="text-primary">{t('collaboration.signIn')}</Text></Pressable>
      : <Pressable accessibilityRole="button" disabled={join.isPending || !token} onPress={() => join.mutate()}><Text className="text-primary">{t('collaboration.accept')}</Text></Pressable>}
    {join.isError ? <Text selectable accessibilityRole="alert" className="text-error">{join.error.message}</Text> : null}
  </ScrollView>;
}
