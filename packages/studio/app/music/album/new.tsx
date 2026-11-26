import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Button } from '@oxy.so/bloom/button';
import { Switch } from '@oxy.so/bloom/switch';
import { Loading } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import type { CreateAlbumRequest } from '@syra/shared-types';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { FormField } from '@/components/FormField';
import { CoverArtPicker } from '@/components/CoverArtPicker';
import { useMyArtistProfile } from '@/hooks/useArtist';
import { useCreateAlbum } from '@/hooks/useMusic';
import { getApiErrorMessage } from '@/utils/api';
import { toast } from '@oxy.so/bloom/toast';
import { cn } from '@/lib/utils';
import { createTokenStyles, tokenAlpha } from '@oxy.so/bloom/theme';

type AlbumType = NonNullable<CreateAlbumRequest['type']>;

const ALBUM_TYPES: { value: AlbumType; label: string }[] = [
  { value: 'album', label: 'Album' },
  { value: 'single', label: 'Single' },
  { value: 'ep', label: 'EP' },
  { value: 'compilation', label: 'Compilation' },
];

function TypeSelector({
  value,
  onChange,
  disabled,
}: {
  value: AlbumType;
  onChange: (value: AlbumType) => void;
  disabled: boolean;
}) {
  const styles = useStyles();
  return (
    <View style={styles.section}>
      <Text style={styles.text}>Type</Text>
      <View style={styles.row}>
        {ALBUM_TYPES.map((option) => {
          const active = option.value === value;
          return (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              disabled={disabled}
              className={cn(
                'rounded-full border px-4 py-2',
                active ? 'border-primary bg-primary/10' : 'border-border bg-surface',
              )}
            >
              <Text
                className={cn('text-sm font-semibold', active ? 'text-primary' : 'text-foreground')}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function CreateAlbumForm({
  artistId,
  uploadsDisabled,
}: {
  artistId: string;
  uploadsDisabled: boolean;
}) {
  const styles = useStyles();
  const router = useRouter();
  const theme = useTheme();
  const createAlbum = useCreateAlbum();

  const [title, setTitle] = useState('');
  const [releaseDate, setReleaseDate] = useState('');
  const [type, setType] = useState<AlbumType>('album');
  const [coverArt, setCoverArt] = useState<string | null>(null);
  const [genres, setGenres] = useState('');
  const [label, setLabel] = useState('');
  const [explicit, setExplicit] = useState(false);
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
  const [releaseDateError, setReleaseDateError] = useState<string | undefined>(undefined);
  const [coverError, setCoverError] = useState<string | undefined>(undefined);

  const busy = createAlbum.isPending;

  const onSubmit = useCallback(async () => {
    const trimmedTitle = title.trim();
    const trimmedDate = releaseDate.trim();
    let valid = true;

    if (!trimmedTitle) {
      setTitleError('An album title is required');
      valid = false;
    } else {
      setTitleError(undefined);
    }
    if (!trimmedDate) {
      setReleaseDateError('A release date is required');
      valid = false;
    } else {
      setReleaseDateError(undefined);
    }
    if (!coverArt) {
      setCoverError('Cover art is required');
      valid = false;
    } else {
      setCoverError(undefined);
    }
    if (!valid || !coverArt) return;

    const genreList = genres
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean);

    const payload: CreateAlbumRequest = {
      title: trimmedTitle,
      artistId,
      releaseDate: trimmedDate,
      coverArt,
      type,
      genre: genreList.length > 0 ? genreList : undefined,
      label: label.trim() || undefined,
      isExplicit: explicit,
    };

    try {
      await createAlbum.mutateAsync(payload);
      toast.success('Album created');
      router.replace('/music');
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Could not create the album. Please try again.'));
    }
  }, [title, releaseDate, coverArt, genres, label, type, explicit, artistId, createAlbum, router]);

  return (
    <ScreenContainer
      title="Create album"
      subtitle="Group your tracks into a release"
      onBack={() => router.back()}
    >
      {uploadsDisabled ? (
        <View style={styles.row2}>
          <MaterialCommunityIcons name="alert-circle" size={22} color={theme.colors.error} />
          <Text style={styles.text2}>
            Uploads are disabled due to copyright strikes. Contact support for more information.
          </Text>
        </View>
      ) : null}

      <View style={styles.container}>
        <CoverArtPicker
          value={coverArt}
          onChange={setCoverArt}
          size={180}
          disabled={busy}
          error={coverError}
        />
        <Text style={styles.mutedText}>Cover art (required)</Text>
      </View>

      <FormField
        label="Title"
        placeholder="Album title"
        value={title}
        onChangeText={setTitle}
        error={titleError}
        maxLength={120}
        editable={!busy}
      />
      <FormField
        label="Release date"
        placeholder="YYYY-MM-DD"
        value={releaseDate}
        onChangeText={setReleaseDate}
        error={releaseDateError}
        autoCapitalize="none"
        editable={!busy}
      />
      <TypeSelector value={type} onChange={setType} disabled={busy} />
      <FormField
        label="Genres"
        placeholder="Pop, Electronic"
        hint="Comma-separated."
        value={genres}
        onChangeText={setGenres}
        editable={!busy}
      />
      <FormField
        label="Label (optional)"
        placeholder="Record label"
        value={label}
        onChangeText={setLabel}
        editable={!busy}
      />

      <View style={styles.row3}>
        <View style={styles.container2}>
          <Text style={styles.text3}>Explicit content</Text>
          <Text style={styles.mutedText2}>Marks this release as explicit.</Text>
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
        Create album
      </Button>
    </ScreenContainer>
  );
}

function CreateAlbumGate() {
  const styles = useStyles();
  const router = useRouter();
  const theme = useTheme();
  const { data: artist, isLoading } = useMyArtistProfile();

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <Loading />
      </View>
    );
  }

  if (!artist) {
    return (
      <ScreenContainer title="Create album" onBack={() => router.back()}>
        <View style={styles.centered2}>
          <View style={styles.centered3}>
            <MaterialCommunityIcons name="account-music" size={30} color={theme.colors.primary} />
          </View>
          <Text style={styles.title}>Register as an artist first</Text>
          <Text style={styles.mutedText3}>Create your artist profile before creating albums.</Text>
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

  return <CreateAlbumForm artistId={artist.id} uploadsDisabled={artist.uploadsDisabled ?? false} />;
}

export default function NewAlbumScreen() {
  return (
    <SignInGate>
      <CreateAlbumGate />
    </SignInGate>
  );
}

const useStyles = createTokenStyles((t) => ({
  section: { marginBottom: 16 },
  text: { marginBottom: 6, fontSize: 14, fontWeight: 500, color: t.foreground, lineHeight: 20 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
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
  text2: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: 14,
    color: t.foreground,
    lineHeight: 20,
  },
  container: { marginBottom: 24, alignItems: 'center' },
  mutedText: { marginTop: 8, fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
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
  container2: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', paddingRight: 12 },
  text3: { fontSize: 14, fontWeight: 500, color: t.foreground, lineHeight: 20 },
  mutedText2: { marginTop: 2, fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
  centered: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.background,
  },
  centered2: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 64,
  },
  centered3: {
    marginBottom: 16,
    height: 64,
    width: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: tokenAlpha(t.primary, 0.1),
  },
  title: { marginBottom: 4, fontSize: 18, fontWeight: 600, color: t.foreground, lineHeight: 28 },
  mutedText3: {
    marginBottom: 20,
    maxWidth: 360,
    textAlign: 'center',
    fontSize: 14,
    color: t.mutedForeground,
    lineHeight: 20,
  },
}));
