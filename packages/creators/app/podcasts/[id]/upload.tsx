import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Button } from '@oxyhq/bloom/button';
import { Switch } from '@oxyhq/bloom/switch';
import { useTheme } from '@oxyhq/bloom/theme';
import type { EpisodeType } from '@syra/shared-types';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { FormField } from '@/components/FormField';
import { HostsGuestsPicker, type HostsGuests } from '@/components/HostsGuestsPicker';
import { useUploadEpisode } from '@/hooks/usePodcasts';
import type { EpisodeAudioFile } from '@/services/episodeService';
import { extractInvalidIds } from '@/utils/api';
import { toast } from '@/lib/sonner';
import { cn } from '@/lib/utils';

const EPISODE_TYPES: { value: EpisodeType; label: string }[] = [
  { value: 'full', label: 'Full' },
  { value: 'trailer', label: 'Trailer' },
  { value: 'bonus', label: 'Bonus' },
];

function parsePositiveInt(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function AudioPicker({ file, onPick }: { file: EpisodeAudioFile | null; onPick: () => void }) {
  const theme = useTheme();
  return (
    <View className="mb-4">
      <Text className="text-sm font-medium text-foreground mb-1.5">Audio file</Text>
      <Pressable
        onPress={onPick}
        className="flex-row items-center gap-3 rounded-xl border border-dashed border-border bg-surface px-4 py-4 active:opacity-80"
      >
        <View className="w-10 h-10 rounded-lg bg-primary/10 items-center justify-center">
          <MaterialCommunityIcons name={file ? 'music-box' : 'cloud-upload-outline'} size={22} color={theme.colors.primary} />
        </View>
        <View className="flex-1">
          <Text numberOfLines={1} className="text-sm font-medium text-foreground">
            {file ? file.name : 'Choose an audio file'}
          </Text>
          <Text className="text-xs text-muted-foreground mt-0.5">
            {file ? 'Tap to replace' : 'MP3, M4A, WAV, OGG, FLAC'}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

function TypeSelector({ value, onChange }: { value: EpisodeType; onChange: (value: EpisodeType) => void }) {
  return (
    <View className="mb-4">
      <Text className="text-sm font-medium text-foreground mb-1.5">Episode type</Text>
      <View className="flex-row gap-2">
        {EPISODE_TYPES.map((option) => {
          const active = option.value === value;
          return (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              className={cn(
                'flex-1 rounded-xl border px-3 py-2.5 items-center',
                active ? 'border-primary bg-primary/10' : 'border-border bg-surface',
              )}
            >
              <Text className={cn('text-sm font-semibold', active ? 'text-primary' : 'text-foreground')}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function UploadEpisodeForm({ id }: { id: string }) {
  const router = useRouter();
  const uploadEpisode = useUploadEpisode();

  const [audioFile, setAudioFile] = useState<EpisodeAudioFile | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [season, setSeason] = useState('');
  const [episodeNumber, setEpisodeNumber] = useState('');
  const [episodeType, setEpisodeType] = useState<EpisodeType>('full');
  const [explicit, setExplicit] = useState(false);
  const [hostsGuests, setHostsGuests] = useState<HostsGuests>({ hosts: [], guests: [] });
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
  const [audioError, setAudioError] = useState<string | undefined>(undefined);

  const pickAudio = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'audio/*',
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;
    setAudioError(undefined);
    setAudioFile({
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType ?? undefined,
      file: asset.file,
    });
  }, []);

  const onSubmit = useCallback(async () => {
    const trimmedTitle = title.trim();
    let valid = true;
    if (!trimmedTitle) {
      setTitleError('An episode title is required');
      valid = false;
    } else {
      setTitleError(undefined);
    }
    if (!audioFile) {
      setAudioError('Choose an audio file to upload');
      valid = false;
    }
    if (!valid || !audioFile) return;

    const hostIds = hostsGuests.hosts.map((u) => u.id);
    const guestIds = hostsGuests.guests.map((u) => u.id);

    try {
      await uploadEpisode.mutateAsync({
        podcastId: id,
        audioFile,
        metadata: {
          title: trimmedTitle,
          description: description.trim() || undefined,
          season: parsePositiveInt(season),
          episodeNumber: parsePositiveInt(episodeNumber),
          episodeType,
          explicit,
          hosts: hostIds.length > 0 ? hostIds : undefined,
          guests: guestIds.length > 0 ? guestIds : undefined,
        },
      });
      toast.success('Episode uploaded — processing now');
      router.back();
    } catch (error) {
      const invalidIds = extractInvalidIds(error);
      if (invalidIds) {
        toast.error('Some hosts/guests are not valid Oxy users. Remove them and try again.');
      } else {
        toast.error('Upload failed. Please try again.');
      }
    }
  }, [title, audioFile, description, season, episodeNumber, episodeType, explicit, hostsGuests, id, uploadEpisode, router]);

  return (
    <ScreenContainer title="Upload episode" onBack={() => router.back()}>
      <AudioPicker file={audioFile} onPick={pickAudio} />
      {audioError ? <Text className="text-xs text-destructive -mt-2 mb-3">{audioError}</Text> : null}

      <FormField
        label="Title"
        placeholder="Episode 1: Getting started"
        value={title}
        onChangeText={setTitle}
        error={titleError}
        maxLength={160}
      />
      <FormField
        label="Description / show notes"
        placeholder="What happens in this episode?"
        value={description}
        onChangeText={setDescription}
        multiline
      />
      <View className="flex-row gap-3">
        <View className="flex-1">
          <FormField
            label="Season"
            placeholder="1"
            value={season}
            onChangeText={setSeason}
            keyboardType="number-pad"
          />
        </View>
        <View className="flex-1">
          <FormField
            label="Episode #"
            placeholder="1"
            value={episodeNumber}
            onChangeText={setEpisodeNumber}
            keyboardType="number-pad"
          />
        </View>
      </View>
      <TypeSelector value={episodeType} onChange={setEpisodeType} />
      <HostsGuestsPicker value={hostsGuests} onChange={setHostsGuests} />
      <View className="flex-row items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 mb-6">
        <View className="flex-1 pr-3">
          <Text className="text-sm font-medium text-foreground">Explicit content</Text>
          <Text className="text-xs text-muted-foreground mt-0.5">Marks this episode as explicit.</Text>
        </View>
        <Switch value={explicit} onValueChange={setExplicit} />
      </View>
      <Button
        variant="primary"
        fullWidth
        onPress={onSubmit}
        loading={uploadEpisode.isPending}
        disabled={uploadEpisode.isPending}
      >
        Upload episode
      </Button>
    </ScreenContainer>
  );
}

export default function UploadEpisodeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <SignInGate>
      {id ? <UploadEpisodeForm id={id} /> : null}
    </SignInGate>
  );
}
