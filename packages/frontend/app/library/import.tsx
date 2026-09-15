import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import { useTranslation } from 'react-i18next';
import * as DocumentPicker from 'expo-document-picker';
import { randomUUID } from 'expo-crypto';
import { listenerTools } from '@/services/listener-tools-service';
import { parsePlaylistMetadata, PLAYLIST_METADATA_MAX_BYTES } from '@/utils/playlist-metadata';
import { useAuthGate } from '@/hooks/useAuthGate';

type Preview = Awaited<ReturnType<typeof listenerTools.previewImport>>;

export default function ImportPlaylistScreen() {
  const gate = useAuthGate();
  const { user } = useOxy();
  const { t } = useTranslation();
  return <ScrollView className="flex-1 bg-background" contentContainerClassName="p-6 pb-36 gap-4 w-full max-w-4xl mx-auto" contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
    <Stack.Screen options={{ title: t('tools.import') }} />
    <Text className="text-3xl font-bold text-foreground">{t('tools.import')}</Text>
    <Text className="text-muted-foreground">{t('tools.importHint')}</Text>
    {gate.isResolving ? <ActivityIndicator /> : null}
    {gate.isTimedOut ? <Pressable accessibilityRole="button" onPress={gate.retry}><Text className="text-primary">{t('listener.retry')}</Text></Pressable> : null}
    {gate.status === 'guest' ? <Text className="text-muted-foreground">{t('listener.signIn')}</Text> : null}
    {gate.canUsePrivateApi && user ? <ImportForm key={user.id} /> : null}
  </ScrollView>;
}

function ImportForm() {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [raw, setRaw] = useState('');
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [requestId, setRequestId] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const previewMutation = useMutation({
    mutationFn: async () => listenerTools.previewImport(parsePlaylistMetadata(raw)),
    onSuccess: (data) => {
      setPreview(data);
      setSelected(data.items.filter((item) => item.status === 'matched').map((item) => item.index));
      setRequestId(randomUUID());
    },
  });
  const commit = useMutation({
    mutationFn: () => listenerTools.commitImport(name.trim() || t('tools.importedPlaylist'),
      preview?.items.flatMap((item) => item.track && selected.includes(item.index) ? [item.track.id] : []) ?? [], requestId),
    onSuccess: async ({ playlistId }) => {
      await queryClient.invalidateQueries({ queryKey: ['library'] });
      router.replace({ pathname: '/playlist/[id]', params: { id: playlistId } });
    },
  });
  const busy = picking || previewMutation.isPending || commit.isPending;
  const handleText = (value: string) => { setRaw(value); setPreview(null); setFileError(null); previewMutation.reset(); commit.reset(); };
  const handlePick = async () => {
    setPicking(true); setFileError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'application/json', 'text/plain'], copyToCacheDirectory: true });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset || (asset.size ?? 0) > PLAYLIST_METADATA_MAX_BYTES) throw new Error('tools.importLimit');
      let contents: string;
      if (Platform.OS === 'web') {
        if (!asset.file || asset.file.size > PLAYLIST_METADATA_MAX_BYTES) throw new Error('tools.importInvalid');
        contents = await asset.file.text();
      } else {
        const { File } = await import('expo-file-system');
        const file = new File(asset.uri);
        if (!file.exists || file.size > PLAYLIST_METADATA_MAX_BYTES) throw new Error('tools.importLimit');
        contents = await file.text();
      }
      parsePlaylistMetadata(contents);
      handleText(contents);
    } catch (error) {
      setFileError(error instanceof Error && error.message.startsWith('tools.') ? error.message : 'tools.importInvalid');
    } finally { setPicking(false); }
  };
  return <View className="gap-4">
    <TextInput accessibilityLabel={t('tools.playlistName')} placeholder={t('tools.playlistName')} value={name} editable={!busy} maxLength={200}
      onChangeText={(value) => { setName(value); if (preview) setRequestId(randomUUID()); }} className="p-4 rounded-xl bg-surface text-foreground" />
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void handlePick()} className="p-3 rounded-xl bg-surface"><Text className="text-primary">{t('tools.chooseFile')}</Text></Pressable>
    <TextInput accessibilityLabel={t('tools.pasteMetadata')} placeholder={t('tools.pasteMetadata')} value={raw} editable={!busy}
      onChangeText={handleText} multiline maxLength={PLAYLIST_METADATA_MAX_BYTES} textAlignVertical="top" className="p-4 min-h-48 rounded-xl bg-surface text-foreground" />
    <Text className="text-sm text-muted-foreground">{t('tools.importFormat')}</Text>
    {fileError ? <Text accessibilityRole="alert" className="text-destructive">{t(fileError)}</Text> : null}
    {previewMutation.isError ? <Text accessibilityRole="alert" className="text-destructive">{t(previewMutation.error instanceof Error && previewMutation.error.message.startsWith('tools.') ? previewMutation.error.message : 'tools.previewFailed')}</Text> : null}
    <Pressable accessibilityRole="button" disabled={busy || !raw.trim()} onPress={() => previewMutation.mutate()} className={`p-4 rounded-full bg-primary ${busy || !raw.trim() ? 'opacity-50' : ''}`}>
      <Text className="text-center font-semibold text-primary-foreground">{t('tools.preview')}</Text>
    </Pressable>
    {busy ? <ActivityIndicator /> : null}
    {preview ? <View className="gap-3">
      <Text className="text-lg font-semibold text-foreground">{t('tools.matchSummary', { count: selected.length, total: preview.items.length })}</Text>
      <Text className="text-muted-foreground">{t('tools.matchHint')}</Text>
      {preview.items.map((item) => <Pressable key={item.index} accessibilityRole="checkbox" accessibilityState={{ checked: selected.includes(item.index), disabled: !item.track || busy }}
        disabled={!item.track || busy} onPress={() => { setSelected((ids) => ids.includes(item.index) ? ids.filter((id) => id !== item.index) : [...ids, item.index]); setRequestId(randomUUID()); }}
        className="p-3 rounded-xl bg-surface flex-row items-center gap-3">
        <Text className="text-primary">{item.track ? (selected.includes(item.index) ? '✓' : '○') : '—'}</Text>
        <View className="flex-1 gap-1"><Text className="text-foreground">{item.track?.title ?? t('tools.importRow', { index: item.index + 1 })}</Text>
          <Text className="text-muted-foreground">{item.track?.artistName ?? t(`tools.match_${item.status}`)}</Text></View>
      </Pressable>)}
      {commit.isError ? <Text accessibilityRole="alert" className="text-destructive">{t('tools.saveFailed')}</Text> : null}
      <Pressable accessibilityRole="button" disabled={busy || !selected.length} onPress={() => commit.mutate()} className={`p-4 rounded-full bg-primary ${busy || !selected.length ? 'opacity-50' : ''}`}>
        <Text className="text-center font-semibold text-primary-foreground">{t('tools.createPlaylist')}</Text>
      </Pressable>
    </View> : null}
  </View>;
}
