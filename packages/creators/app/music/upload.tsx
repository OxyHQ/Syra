import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Button } from '@oxyhq/bloom/button';
import { Switch } from '@oxyhq/bloom/switch';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import type { Album } from '@syra/shared-types';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { FormField } from '@/components/FormField';
import { CoverArtPicker } from '@/components/CoverArtPicker';
import { useMyArtistProfile } from '@/hooks/useArtist';
import { useMyAlbums, useUploadTrack } from '@/hooks/useMusic';
import type { TrackAudioFile } from '@/services/musicService';
import { getApiErrorMessage } from '@/utils/api';
import { toast } from '@/lib/sonner';
import { cn } from '@/lib/utils';

function parsePositiveNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function AudioPicker({ file, onPick, disabled }: { file: TrackAudioFile | null; onPick: () => void; disabled: boolean }) {
  const theme = useTheme();
  return (
    <View className="mb-4">
      <Text className="text-sm font-medium text-foreground mb-1.5">Audio file</Text>
      <Pressable
        onPress={onPick}
        disabled={disabled}
        className={cn(
          'flex-row items-center gap-3 rounded-xl border border-dashed border-border bg-surface px-4 py-4 active:opacity-80',
          disabled ? 'opacity-50' : '',
        )}
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

function AlbumPicker({
  albums,
  selectedId,
  onSelect,
  disabled,
}: {
  albums: Album[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  disabled: boolean;
}) {
  return (
    <View className="mb-4">
      <Text className="text-sm font-medium text-foreground mb-1.5">Album (optional)</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
        <Pressable
          onPress={() => onSelect(null)}
          disabled={disabled}
          className={cn(
            'rounded-full border px-4 py-2',
            !selectedId ? 'border-primary bg-primary/10' : 'border-border bg-surface',
          )}
        >
          <Text className={cn('text-sm font-medium', !selectedId ? 'text-primary' : 'text-foreground')}>None</Text>
        </Pressable>
        {albums.map((album) => {
          const active = selectedId === album.id;
          return (
            <Pressable
              key={album.id}
              onPress={() => onSelect(album.id)}
              disabled={disabled}
              className={cn(
                'rounded-full border px-4 py-2',
                active ? 'border-primary bg-primary/10' : 'border-border bg-surface',
              )}
            >
              <Text numberOfLines={1} className={cn('text-sm font-medium', active ? 'text-primary' : 'text-foreground')}>
                {album.title}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function UploadProgress({ phase }: { phase: 'uploading' | 'processing' }) {
  const label =
    phase === 'uploading' ? 'Uploading your track…' : 'Processing audio (transcoding for streaming)…';
  return (
    <View className="flex-row items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 mb-4">
      <Loading />
      <Text className="text-sm text-foreground flex-1">{label}</Text>
    </View>
  );
}

function UploadDisabledNotice() {
  const theme = useTheme();
  return (
    <View className="flex-row gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 mb-4">
      <MaterialCommunityIcons name="alert-circle" size={22} color={theme.colors.error} />
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">Uploads disabled</Text>
        <Text className="text-xs text-muted-foreground mt-0.5">
          Uploads are disabled due to copyright strikes. Contact support for more information.
        </Text>
      </View>
    </View>
  );
}

function UploadTrackForm({ artistId, uploadsDisabled }: { artistId: string; uploadsDisabled: boolean }) {
  const router = useRouter();
  const uploadTrack = useUploadTrack();
  const { data: albums } = useMyAlbums(artistId);

  const [audioFile, setAudioFile] = useState<TrackAudioFile | null>(null);
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState('');
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [coverArt, setCoverArt] = useState<string | null>(null);
  const [genres, setGenres] = useState('');
  const [explicit, setExplicit] = useState(false);
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
  const [durationError, setDurationError] = useState<string | undefined>(undefined);
  const [audioError, setAudioError] = useState<string | undefined>(undefined);

  const busy = uploadTrack.isPending;

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
    const durationSeconds = parsePositiveNumber(duration);
    let valid = true;

    if (!trimmedTitle) {
      setTitleError('A track title is required');
      valid = false;
    } else {
      setTitleError(undefined);
    }
    if (durationSeconds === undefined) {
      setDurationError('Enter the duration in seconds');
      valid = false;
    } else {
      setDurationError(undefined);
    }
    if (!audioFile) {
      setAudioError('Choose an audio file to upload');
      valid = false;
    }
    if (!valid || !audioFile || durationSeconds === undefined) return;

    const genreList = genres
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean);

    try {
      const track = await uploadTrack.mutateAsync({
        audioFile,
        metadata: {
          title: trimmedTitle,
          artistId,
          albumId: albumId ?? undefined,
          coverArt: coverArt ?? undefined,
          genre: genreList.length > 0 ? genreList : undefined,
          isExplicit: explicit,
          duration: durationSeconds,
        },
      });

      if (track.status === 'ready') {
        toast.success('Track uploaded — it is live now');
        router.replace('/music');
      } else if (track.status === 'failed') {
        toast.error('Processing failed. Please check the file and try again.');
        uploadTrack.reset();
      } else {
        toast.success('Track uploaded — it will finish processing in the background');
        router.replace('/music');
      }
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Upload failed. Please try again.'));
      uploadTrack.reset();
    }
  }, [title, duration, audioFile, genres, artistId, albumId, coverArt, explicit, uploadTrack, router]);

  return (
    <ScreenContainer title="Upload song" subtitle="Add a track to your catalog" onBack={() => router.back()}>
      {uploadsDisabled ? <UploadDisabledNotice /> : null}
      {uploadTrack.phase === 'uploading' || uploadTrack.phase === 'processing' ? (
        <UploadProgress phase={uploadTrack.phase} />
      ) : null}

      <AudioPicker file={audioFile} onPick={pickAudio} disabled={busy || uploadsDisabled} />
      {audioError ? <Text className="text-xs text-destructive -mt-2 mb-3">{audioError}</Text> : null}

      <FormField
        label="Title"
        placeholder="Track title"
        value={title}
        onChangeText={setTitle}
        error={titleError}
        maxLength={120}
        editable={!busy}
      />
      <FormField
        label="Duration (seconds)"
        placeholder="180"
        value={duration}
        onChangeText={setDuration}
        error={durationError}
        keyboardType="number-pad"
        editable={!busy}
      />

      {albums && albums.length > 0 ? (
        <AlbumPicker albums={albums} selectedId={albumId} onSelect={setAlbumId} disabled={busy} />
      ) : null}

      <View className="mb-4">
        <Text className="text-sm font-medium text-foreground mb-1.5">Cover art (optional)</Text>
        <CoverArtPicker value={coverArt} onChange={setCoverArt} size={140} disabled={busy} />
      </View>

      <FormField
        label="Genres"
        placeholder="Pop, Electronic"
        hint="Comma-separated."
        value={genres}
        onChangeText={setGenres}
        editable={!busy}
      />

      <View className="flex-row items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 mb-6">
        <View className="flex-1 pr-3">
          <Text className="text-sm font-medium text-foreground">Explicit content</Text>
          <Text className="text-xs text-muted-foreground mt-0.5">Marks this track as explicit.</Text>
        </View>
        <Switch value={explicit} onValueChange={setExplicit} disabled={busy} />
      </View>

      <Button
        variant="primary"
        fullWidth
        onPress={onSubmit}
        loading={busy}
        disabled={busy || uploadsDisabled}
      >
        Upload song
      </Button>
    </ScreenContainer>
  );
}

function UploadGate() {
  const router = useRouter();
  const theme = useTheme();
  const { data: artist, isLoading } = useMyArtistProfile();

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Loading />
      </View>
    );
  }

  if (!artist) {
    return (
      <ScreenContainer title="Upload song" onBack={() => router.back()}>
        <View className="items-center justify-center py-16 px-6">
          <View className="w-16 h-16 rounded-2xl bg-primary/10 items-center justify-center mb-4">
            <MaterialCommunityIcons name="account-music" size={30} color={theme.colors.primary} />
          </View>
          <Text className="text-lg font-semibold text-foreground mb-1">Register as an artist first</Text>
          <Text className="text-sm text-muted-foreground text-center mb-5 max-w-[360px]">
            Create your artist profile before uploading music.
          </Text>
          <Button variant="primary" onPress={() => router.replace('/music/register')}>
            Become an artist
          </Button>
        </View>
      </ScreenContainer>
    );
  }

  return <UploadTrackForm artistId={artist.id} uploadsDisabled={artist.uploadsDisabled ?? false} />;
}

export default function UploadSongScreen() {
  return (
    <SignInGate>
      <UploadGate />
    </SignInGate>
  );
}
