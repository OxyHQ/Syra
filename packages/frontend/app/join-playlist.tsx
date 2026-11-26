import React from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services/ui/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { playlistSharingService } from '@/services/playlistSharingService';
import { createTokenStyles } from '@oxy.so/bloom/theme';

export default function JoinPlaylist() {
  const styles = useStyles();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { canUsePrivateApi, openAccountDialog } = useOxy();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const join = useMutation({
    mutationFn: async () => {
      if (!canUsePrivateApi || !token || !/^[A-Za-z0-9_-]{43}$/.test(token))
        throw new Error(t('collaboration.invalidInvite'));
      return playlistSharingService.join(token);
    },
    onSuccess: async ({ playlistId }) => {
      await queryClient.invalidateQueries({ queryKey: ['library'] });
      await queryClient.invalidateQueries({ queryKey: ['playlist', playlistId] });
      router.replace({ pathname: '/playlist/[id]', params: { id: playlistId } });
    },
  });
  return (
    <ScrollView
      style={styles.surface}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={{ title: t('collaboration.join') }} />
      <Text style={styles.title}>{t('collaboration.join')}</Text>
      <Text style={styles.mutedText}>{t('collaboration.consent')}</Text>
      {!canUsePrivateApi ? (
        <Pressable accessibilityRole="button" onPress={() => openAccountDialog('signin')}>
          <Text style={styles.text}>{t('collaboration.signIn')}</Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          disabled={join.isPending || !token}
          onPress={() => join.mutate()}
        >
          <Text style={styles.text}>{t('collaboration.accept')}</Text>
        </Pressable>
      )}
      {join.isError ? (
        <Text selectable accessibilityRole="alert" style={styles.text2}>
          {join.error.message}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const useStyles = createTokenStyles((t) => ({
  surface: { backgroundColor: t.surface },
  content: { gap: 20, padding: 24 },
  title: { fontSize: 24, fontWeight: 600, color: t.foreground, lineHeight: 32 },
  mutedText: { color: t.mutedForeground },
  text: { color: t.primary },
  text2: { color: t.error },
}));
