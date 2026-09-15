import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import { useTranslation } from 'react-i18next';
import { listenerTools } from '@/services/listener-tools-service';
import { shareUrl } from '@/utils/share-media';
import { useAuthGate } from '@/hooks/useAuthGate';

export default function TasteMixScreen() {
  const gate = useAuthGate();
  const { user } = useOxy();
  const { t } = useTranslation();
  const { invite } = useLocalSearchParams<{ invite?: string }>();
  const token = typeof invite === 'string' && /^[A-Za-z0-9_-]{43}$/.test(invite) ? invite : undefined;
  return <ScrollView className="flex-1 bg-background" contentContainerClassName="p-6 pb-36 gap-5 w-full max-w-4xl mx-auto" contentInsetAdjustmentBehavior="automatic">
    <Stack.Screen options={{ title: t('tools.mixes') }} />
    <Text className="text-3xl font-bold text-foreground">{t('tools.mixes')}</Text>
    <Text className="text-muted-foreground">{t('tools.mixConsent')}</Text>
    {invite && !token ? <Text accessibilityRole="alert" className="text-destructive">{t('tools.inviteInvalid')}</Text> : null}
    {gate.isResolving ? <ActivityIndicator /> : null}
    {gate.isTimedOut ? <Pressable accessibilityRole="button" onPress={gate.retry}><Text className="text-primary">{t('listener.retry')}</Text></Pressable> : null}
    {gate.status === 'guest' ? <Text className="text-muted-foreground">{t('listener.signIn')}</Text> : null}
    {gate.canUsePrivateApi && user ? <MixManager key={`${user.id}:${token ?? ''}`} userId={user.id} token={token} /> : null}
  </ScrollView>;
}

function MixManager({ userId, token }: { userId: string; token?: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [consent, setConsent] = useState(false);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const key = ['taste-mixes', userId] as const;
  const mixes = useQuery({ queryKey: key, queryFn: listenerTools.mixes });
  const create = useMutation({ mutationFn: listenerTools.createMix, onSuccess: async (invite) => {
    setIssuedToken(invite.token); setConsent(false);
    await queryClient.invalidateQueries({ queryKey: key });
  } });
  const join = useMutation({ mutationFn: async () => {
    if (!token || !consent) throw new Error('Consent is required');
    return listenerTools.joinMix(token);
  }, onSuccess: async ({ playlistId }) => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: key }), queryClient.invalidateQueries({ queryKey: ['library'] })]);
    router.replace({ pathname: '/playlist/[id]', params: { id: playlistId } });
  } });
  const revoke = useMutation({ mutationFn: listenerTools.revokeMix, onSuccess: async () => {
    setConfirmId(null); setIssuedToken(null);
    await Promise.all([queryClient.invalidateQueries({ queryKey: key }), queryClient.invalidateQueries({ queryKey: ['library'] }), queryClient.invalidateQueries({ queryKey: ['playlist'] })]);
  } });
  const busy = create.isPending || join.isPending || revoke.isPending;
  const handleShare = async () => {
    if (!issuedToken) return;
    const url = new URL('/library/mixes', process.env.EXPO_PUBLIC_APP_URL ?? 'https://syra.fm');
    url.searchParams.set('invite', issuedToken);
    await shareUrl(t('tools.mixes'), url.toString());
  };
  return <View className="gap-4">
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: consent, disabled: busy }} disabled={busy}
      onPress={() => setConsent((value) => !value)} className="p-4 rounded-xl bg-surface flex-row items-center gap-3">
      <Text className="text-primary">{consent ? '✓' : '○'}</Text><Text className="flex-1 text-foreground">{t('tools.consentAction')}</Text>
    </Pressable>
    <Pressable accessibilityRole="button" disabled={!consent || busy} onPress={() => token ? join.mutate() : create.mutate()} className={`p-4 rounded-full bg-primary ${!consent || busy ? 'opacity-50' : ''}`}>
      <Text className="text-center font-semibold text-primary-foreground">{t(token ? 'tools.joinMix' : 'tools.inviteMix')}</Text>
    </Pressable>
    {issuedToken ? <View className="p-4 rounded-xl bg-surface gap-2"><Text className="text-muted-foreground">{t('tools.inviteLifetime')}</Text>
      <Pressable accessibilityRole="button" onPress={() => void handleShare()}><Text className="text-primary">{t('tools.shareInvite')}</Text></Pressable></View> : null}
    {busy || mixes.isPending ? <ActivityIndicator /> : null}
    {create.isError || join.isError ? <Text accessibilityRole="alert" className="text-destructive">{t('tools.mixFailed')}</Text> : null}
    {revoke.isError ? <Text accessibilityRole="alert" className="text-destructive">{t('tools.saveFailed')}</Text> : null}
    {mixes.isError ? <Pressable accessibilityRole="button" onPress={() => void mixes.refetch()}><Text className="text-primary">{t('listener.retry')}</Text></Pressable> : null}
    {mixes.isSuccess && !mixes.data.length ? <Text className="text-muted-foreground">{t('tools.mixEmpty')}</Text> : null}
    {mixes.data?.map((mix) => <View key={mix.id} className="p-4 rounded-xl bg-surface gap-3">
      {mix.playlistId ? <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: '/playlist/[id]', params: { id: mix.playlistId ?? '' } })}><Text className="text-lg text-primary">{t('tools.openMix')}</Text></Pressable>
        : <Text className="text-foreground">{t(Date.parse(mix.expiresAt) <= Date.now() ? 'tools.inviteExpired' : 'tools.invitePending')}</Text>}
      {confirmId === mix.id ? <><Text className="text-muted-foreground">{t('tools.withdrawHint')}</Text><View className="flex-row flex-wrap gap-5">
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => revoke.mutate(mix.id)}><Text className="text-destructive">{t('tools.confirmWithdraw')}</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => setConfirmId(null)}><Text className="text-primary">{t('common.cancel')}</Text></Pressable>
      </View></> : <Pressable accessibilityRole="button" disabled={busy} onPress={() => setConfirmId(mix.id)}><Text className="text-muted-foreground">{t('tools.withdraw')}</Text></Pressable>}
    </View>)}
  </View>;
}
