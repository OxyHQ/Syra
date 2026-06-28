import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Button } from '@oxyhq/bloom/button';
import { Switch } from '@oxyhq/bloom/switch';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import type { CreateAlbumRequest } from '@syra/shared-types';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { FormField } from '@/components/FormField';
import { CoverArtPicker } from '@/components/CoverArtPicker';
import { useMyArtistProfile } from '@/hooks/useArtist';
import { useCreateAlbum } from '@/hooks/useMusic';
import { getApiErrorMessage } from '@/utils/api';
import { toast } from '@/lib/sonner';
import { cn } from '@/lib/utils';

type AlbumType = NonNullable<CreateAlbumRequest['type']>;

const ALBUM_TYPES: { value: AlbumType; label: string }[] = [
  { value: 'album', label: 'Album' },
  { value: 'single', label: 'Single' },
  { value: 'ep', label: 'EP' },
  { value: 'compilation', label: 'Compilation' },
];

function TypeSelector({ value, onChange, disabled }: { value: AlbumType; onChange: (value: AlbumType) => void; disabled: boolean }) {
  return (
    <View className="mb-4">
      <Text className="text-sm font-medium text-foreground mb-1.5">Type</Text>
      <View className="flex-row flex-wrap gap-2">
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

function CreateAlbumForm({ artistId, uploadsDisabled }: { artistId: string; uploadsDisabled: boolean }) {
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
    <ScreenContainer title="Create album" subtitle="Group your tracks into a release" onBack={() => router.back()}>
      {uploadsDisabled ? (
        <View className="flex-row gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 mb-4">
          <MaterialCommunityIcons name="alert-circle" size={22} color={theme.colors.error} />
          <Text className="text-sm text-foreground flex-1">
            Uploads are disabled due to copyright strikes. Contact support for more information.
          </Text>
        </View>
      ) : null}

      <View className="items-center mb-6">
        <CoverArtPicker value={coverArt} onChange={setCoverArt} size={180} disabled={busy} error={coverError} />
        <Text className="text-xs text-muted-foreground mt-2">Cover art (required)</Text>
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

      <View className="flex-row items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 mb-6">
        <View className="flex-1 pr-3">
          <Text className="text-sm font-medium text-foreground">Explicit content</Text>
          <Text className="text-xs text-muted-foreground mt-0.5">Marks this release as explicit.</Text>
        </View>
        <Switch value={explicit} onValueChange={setExplicit} disabled={busy} />
      </View>

      <Button variant="primary" fullWidth onPress={onSubmit} loading={busy} disabled={busy || uploadsDisabled}>
        Create album
      </Button>
    </ScreenContainer>
  );
}

function CreateAlbumGate() {
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
      <ScreenContainer title="Create album" onBack={() => router.back()}>
        <View className="items-center justify-center py-16 px-6">
          <View className="w-16 h-16 rounded-2xl bg-primary/10 items-center justify-center mb-4">
            <MaterialCommunityIcons name="account-music" size={30} color={theme.colors.primary} />
          </View>
          <Text className="text-lg font-semibold text-foreground mb-1">Register as an artist first</Text>
          <Text className="text-sm text-muted-foreground text-center mb-5 max-w-[360px]">
            Create your artist profile before creating albums.
          </Text>
          <Button variant="primary" onPress={() => router.replace('/music/register')}>
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
