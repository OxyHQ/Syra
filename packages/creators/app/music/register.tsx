import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from '@oxyhq/bloom/button';
import type { CreateArtistRequest } from '@syra/shared-types';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { FormField } from '@/components/FormField';
import { CoverArtPicker } from '@/components/CoverArtPicker';
import { useRegisterArtist } from '@/hooks/useArtist';
import { getApiErrorMessage } from '@/utils/api';
import { toast } from '@/lib/sonner';

function RegisterArtistForm() {
  const router = useRouter();
  const registerArtist = useRegisterArtist();

  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [genres, setGenres] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | undefined>(undefined);

  const onSubmit = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('An artist name is required');
      return;
    }
    setNameError(undefined);

    const genreList = genres
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean);

    const payload: CreateArtistRequest = {
      name: trimmedName,
      bio: bio.trim() || undefined,
      image: image ?? undefined,
      genres: genreList.length > 0 ? genreList : undefined,
    };

    try {
      await registerArtist.mutateAsync(payload);
      toast.success('Artist profile created');
      router.replace('/music');
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Could not create your artist profile. Please try again.'));
    }
  }, [name, bio, genres, image, registerArtist, router]);

  return (
    <ScreenContainer
      title="Become an artist"
      subtitle="Create your artist profile to upload music"
      onBack={() => router.back()}
    >
      <View className="items-center mb-6">
        <CoverArtPicker value={image} onChange={setImage} size={140} disabled={registerArtist.isPending} />
        <Text className="text-xs text-muted-foreground mt-2">Artist photo (optional)</Text>
      </View>

      <FormField
        label="Artist name"
        placeholder="Your stage or band name"
        value={name}
        onChangeText={setName}
        error={nameError}
        maxLength={120}
        autoCapitalize="words"
      />
      <FormField
        label="Bio"
        placeholder="Tell listeners about your music"
        value={bio}
        onChangeText={setBio}
        multiline
      />
      <FormField
        label="Genres"
        placeholder="Pop, Electronic, Hip-Hop"
        hint="Comma-separated."
        value={genres}
        onChangeText={setGenres}
      />

      <Button
        variant="primary"
        fullWidth
        onPress={onSubmit}
        loading={registerArtist.isPending}
        disabled={registerArtist.isPending}
      >
        Create artist profile
      </Button>
    </ScreenContainer>
  );
}

export default function RegisterArtistScreen() {
  return (
    <SignInGate>
      <RegisterArtistForm />
    </SignInGate>
  );
}
