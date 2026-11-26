import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Button } from '@oxy.so/bloom/button';
import { Switch } from '@oxy.so/bloom/switch';
import { useTheme } from '@oxy.so/bloom/theme';
import type { EpisodeType } from '@syra/shared-types';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { FormField } from '@/components/FormField';
import { HostsGuestsPicker, type HostsGuests } from '@/components/HostsGuestsPicker';
import { useUploadEpisode } from '@/hooks/usePodcasts';
import type { EpisodeAudioFile } from '@/services/episodeService';
import { extractInvalidIds } from '@/utils/api';
import { toast } from '@oxy.so/bloom/toast';
import { createTokenStyles, tokenAlpha } from '@oxy.so/bloom/theme';

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
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <Text style={styles.text}>Audio file</Text>
      <Pressable
        onPress={onPick}
        style={({ pressed }) => [styles.audioPicker, pressed && styles.pressed]}
      >
        <View style={styles.centered}>
          <MaterialCommunityIcons
            name={file ? 'music-box' : 'cloud-upload-outline'}
            size={22}
            color={theme.colors.primary}
          />
        </View>
        <View style={styles.fill}>
          <Text numberOfLines={1} style={styles.text2}>
            {file ? file.name : 'Choose an audio file'}
          </Text>
          <Text style={styles.mutedText}>
            {file ? 'Tap to replace' : 'MP3, M4A, WAV, OGG, FLAC'}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

function TypeSelector({
  value,
  onChange,
}: {
  value: EpisodeType;
  onChange: (value: EpisodeType) => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.section}>
      <Text style={styles.text}>Episode type</Text>
      <View style={styles.row}>
        {EPISODE_TYPES.map((option) => {
          const active = option.value === value;
          return (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              style={[styles.type, active ? styles.typeActive : styles.typeIdle]}
            >
              <Text style={[styles.typeText, active ? styles.typeTextActive : styles.typeTextIdle]}>
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
  const styles = useStyles();
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
  }, [
    title,
    audioFile,
    description,
    season,
    episodeNumber,
    episodeType,
    explicit,
    hostsGuests,
    id,
    uploadEpisode,
    router,
  ]);

  return (
    <ScreenContainer title="Upload episode" onBack={() => router.back()}>
      <AudioPicker file={audioFile} onPick={pickAudio} />
      {audioError ? <Text style={styles.text3}>{audioError}</Text> : null}

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
      <View style={styles.row2}>
        <View style={styles.fill}>
          <FormField
            label="Season"
            placeholder="1"
            value={season}
            onChangeText={setSeason}
            keyboardType="number-pad"
          />
        </View>
        <View style={styles.fill}>
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
      <View style={styles.row3}>
        <View style={styles.container}>
          <Text style={styles.text2}>Explicit content</Text>
          <Text style={styles.mutedText}>Marks this episode as explicit.</Text>
        </View>
        <Switch checked={explicit} onCheckedChange={setExplicit} />
      </View>
      <Button
        fullWidth
        onPress={onSubmit}
        loading={uploadEpisode.isPending}
        disabled={uploadEpisode.isPending}
        tone="accent"
        appearance="solid"
      >
        Upload episode
      </Button>
    </ScreenContainer>
  );
}

export default function UploadEpisodeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SignInGate>{id ? <UploadEpisodeForm id={id} /> : null}</SignInGate>;
}

const useStyles = createTokenStyles((t) => ({
  audioPicker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 12,
    borderStyle: 'dashed',
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  pressed: { opacity: 0.8 },
  type: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  typeActive: { borderColor: t.primary, backgroundColor: tokenAlpha(t.primary, 0.1) },
  typeIdle: { borderColor: t.border, backgroundColor: t.surface },
  typeText: { fontSize: 14, fontWeight: 600, lineHeight: 20 },
  typeTextActive: { color: t.primary },
  typeTextIdle: { color: t.foreground },
  section: { marginBottom: 16 },
  text: { marginBottom: 6, fontSize: 14, fontWeight: 500, color: t.foreground, lineHeight: 20 },
  centered: {
    height: 40,
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: tokenAlpha(t.primary, 0.1),
  },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  text2: { fontSize: 14, fontWeight: 500, color: t.foreground, lineHeight: 20 },
  mutedText: { marginTop: 2, fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
  row: { flexDirection: 'row', gap: 8 },
  text3: { marginTop: -8, marginBottom: 12, fontSize: 12, color: t.destructive, lineHeight: 16 },
  row2: { flexDirection: 'row', gap: 12 },
  row3: {
    marginBottom: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  container: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', paddingRight: 12 },
}));
