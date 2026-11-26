import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Button } from '@oxy.so/bloom/button';
import { Switch } from '@oxy.so/bloom/switch';
import { Loading } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import type { Album } from '@syra/shared-types';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { FormField } from '@/components/FormField';
import { CoverArtPicker } from '@/components/CoverArtPicker';
import { useMyArtistProfile } from '@/hooks/useArtist';
import { useMyAlbums, useUploadTrack } from '@/hooks/useMusic';
import type { TrackAudioFile } from '@/services/musicService';
import { getApiErrorMessage } from '@/utils/api';
import { toast } from '@oxy.so/bloom/toast';
import { cn } from '@/lib/utils';
import { createTokenStyles, tokenAlpha } from '@oxy.so/bloom/theme';

function AudioPicker({
  file,
  onPick,
  disabled,
}: {
  file: TrackAudioFile | null;
  onPick: () => void;
  disabled: boolean;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <Text style={styles.text}>Audio file</Text>
      <Pressable
        onPress={onPick}
        disabled={disabled}
        className={cn(
          'flex-row items-center gap-3 rounded-xl border border-dashed border-border bg-surface px-4 py-4 active:opacity-80',
          disabled ? 'opacity-50' : '',
        )}
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
  const styles = useStyles();
  return (
    <View style={styles.section}>
      <Text style={styles.text}>Album (optional)</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        <Pressable
          onPress={() => onSelect(null)}
          disabled={disabled}
          className={cn(
            'rounded-full border px-4 py-2',
            !selectedId ? 'border-primary bg-primary/10' : 'border-border bg-surface',
          )}
        >
          <Text
            className={cn('text-sm font-medium', !selectedId ? 'text-primary' : 'text-foreground')}
          >
            None
          </Text>
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
              <Text
                numberOfLines={1}
                className={cn('text-sm font-medium', active ? 'text-primary' : 'text-foreground')}
              >
                {album.title}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function UploadProgress({
  phase,
  progress,
}: {
  phase: 'uploading' | 'processing';
  /** Fraction of the file sent (0–1). */
  progress: number;
}) {
  const styles = useStyles();
  const label =
    phase === 'uploading'
      ? `Uploading your track… ${Math.round(progress * 100)}%`
      : 'Processing audio (transcoding for streaming)…';
  return (
    <View style={styles.row}>
      <Loading />
      <Text style={styles.text3}>{label}</Text>
    </View>
  );
}

function UploadDisabledNotice() {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.row2}>
      <MaterialCommunityIcons name="alert-circle" size={22} color={theme.colors.error} />
      <View style={styles.fill}>
        <Text style={styles.title}>Uploads disabled</Text>
        <Text style={styles.mutedText}>
          Uploads are disabled due to copyright strikes. Contact support for more information.
        </Text>
      </View>
    </View>
  );
}

function UploadTrackForm({
  artistId,
  uploadsDisabled,
}: {
  artistId: string;
  uploadsDisabled: boolean;
}) {
  const styles = useStyles();
  const router = useRouter();
  const uploadTrack = useUploadTrack();
  const { data: albums } = useMyAlbums(artistId);

  const [audioFile, setAudioFile] = useState<TrackAudioFile | null>(null);
  const [title, setTitle] = useState('');
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [coverArt, setCoverArt] = useState<string | null>(null);
  const [genres, setGenres] = useState('');
  const [explicit, setExplicit] = useState(false);
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
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
    let valid = true;

    if (!trimmedTitle) {
      setTitleError('A track title is required');
      valid = false;
    } else {
      setTitleError(undefined);
    }
    if (!audioFile) {
      setAudioError('Choose an audio file to upload');
      valid = false;
    }
    if (!valid || !audioFile) return;

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
  }, [title, audioFile, genres, artistId, albumId, coverArt, explicit, uploadTrack, router]);

  return (
    <ScreenContainer
      title="Upload song"
      subtitle="Add a track to your catalog"
      onBack={() => router.back()}
    >
      {uploadsDisabled ? <UploadDisabledNotice /> : null}
      {uploadTrack.phase === 'uploading' || uploadTrack.phase === 'processing' ? (
        <UploadProgress phase={uploadTrack.phase} progress={uploadTrack.progress} />
      ) : null}

      <AudioPicker file={audioFile} onPick={pickAudio} disabled={busy || uploadsDisabled} />
      {audioError ? <Text style={styles.text4}>{audioError}</Text> : null}

      <FormField
        label="Title"
        placeholder="Track title"
        value={title}
        onChangeText={setTitle}
        error={titleError}
        maxLength={120}
        editable={!busy}
      />

      {albums && albums.length > 0 ? (
        <AlbumPicker albums={albums} selectedId={albumId} onSelect={setAlbumId} disabled={busy} />
      ) : null}

      <View style={styles.section}>
        <Text style={styles.text}>Cover art (optional)</Text>
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

      <View style={styles.row3}>
        <View style={styles.container}>
          <Text style={styles.text2}>Explicit content</Text>
          <Text style={styles.mutedText}>Marks this track as explicit.</Text>
        </View>
        <Switch checked={explicit} onCheckedChange={setExplicit} disabled={busy} />
      </View>

      <Button
        fullWidth
        onPress={onSubmit}
        loading={busy}
        disabled={busy || uploadsDisabled}
        tone="accent"
        appearance="solid"
      >
        Upload song
      </Button>
    </ScreenContainer>
  );
}

function UploadGate() {
  const styles = useStyles();
  const router = useRouter();
  const theme = useTheme();
  const { data: artist, isLoading } = useMyArtistProfile();

  if (isLoading) {
    return (
      <View style={styles.centered2}>
        <Loading />
      </View>
    );
  }

  if (!artist) {
    return (
      <ScreenContainer title="Upload song" onBack={() => router.back()}>
        <View style={styles.centered3}>
          <View style={styles.centered4}>
            <MaterialCommunityIcons name="account-music" size={30} color={theme.colors.primary} />
          </View>
          <Text style={styles.title2}>Register as an artist first</Text>
          <Text style={styles.mutedText2}>Create your artist profile before uploading music.</Text>
          <Button
            onPress={() => router.replace('/music/register')}
            tone="accent"
            appearance="solid"
          >
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

const useStyles = createTokenStyles((t) => ({
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
  content: { gap: 8 },
  row: {
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  text3: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: 14,
    color: t.foreground,
    lineHeight: 20,
  },
  row2: {
    marginBottom: 16,
    flexDirection: 'row',
    gap: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tokenAlpha(t.destructive, 0.4),
    backgroundColor: tokenAlpha(t.destructive, 0.1),
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { fontSize: 14, fontWeight: 600, color: t.foreground, lineHeight: 20 },
  text4: { marginTop: -8, marginBottom: 12, fontSize: 12, color: t.destructive, lineHeight: 16 },
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
  centered2: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.background,
  },
  centered3: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 64,
  },
  centered4: {
    marginBottom: 16,
    height: 64,
    width: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: tokenAlpha(t.primary, 0.1),
  },
  title2: { marginBottom: 4, fontSize: 18, fontWeight: 600, color: t.foreground, lineHeight: 28 },
  mutedText2: {
    marginBottom: 20,
    maxWidth: 360,
    textAlign: 'center',
    fontSize: 14,
    color: t.mutedForeground,
    lineHeight: 20,
  },
}));
