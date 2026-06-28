import { useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter, type Href } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Button } from '@oxyhq/bloom/button';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import type { Artist } from '@syra/shared-types';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { useMyArtistProfile, useArtistDashboard } from '@/hooks/useArtist';
import { resolveCatalogImageUrl } from '@/utils/catalogImages';

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

function ArtistAvatar({ artist, size = 56 }: { artist: Artist; size?: number }) {
  const theme = useTheme();
  const uri = resolveCatalogImageUrl(artist.image);
  if (uri) {
    return (
      <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2 }} contentFit="cover" transition={150} />
    );
  }
  return (
    <View style={{ width: size, height: size }} className="rounded-full bg-primary/10 items-center justify-center">
      <MaterialCommunityIcons name="account-music" size={size * 0.5} color={theme.colors.primary} />
    </View>
  );
}

function StatTile({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  const theme = useTheme();
  return (
    <View className="flex-1 rounded-2xl border border-border bg-surface px-4 py-4">
      <MaterialCommunityIcons name={icon} size={20} color={theme.colors.primary} />
      <Text className="text-2xl font-bold text-foreground mt-2">{value}</Text>
      <Text className="text-xs text-muted-foreground mt-0.5">{label}</Text>
    </View>
  );
}

function ActionCard({ icon, label, hint, onPress }: { icon: IconName; label: string; hint: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3.5 active:opacity-80"
    >
      <View className="w-10 h-10 rounded-xl bg-primary/10 items-center justify-center">
        <MaterialCommunityIcons name={icon} size={22} color={theme.colors.primary} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">{label}</Text>
        <Text className="text-xs text-muted-foreground mt-0.5">{hint}</Text>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={22} color={theme.colors.textSecondary} />
    </Pressable>
  );
}

function BecomeArtistEmptyState({ onRegister }: { onRegister: () => void }) {
  const theme = useTheme();
  return (
    <ScreenContainer title="Music" subtitle="For artists">
      <View className="items-center justify-center py-16 px-6">
        <View className="w-16 h-16 rounded-2xl bg-primary/10 items-center justify-center mb-4">
          <MaterialCommunityIcons name="music" size={30} color={theme.colors.primary} />
        </View>
        <Text className="text-lg font-semibold text-foreground mb-1">Bring your music to Syra</Text>
        <Text className="text-sm text-muted-foreground text-center mb-5 max-w-[360px]">
          Register as an artist to upload songs, organize them into albums, and see how listeners are finding your
          music.
        </Text>
        <Button variant="primary" onPress={onRegister}>Become an artist</Button>
      </View>
    </ScreenContainer>
  );
}

function StudioDashboard({ artist }: { artist: Artist }) {
  const router = useRouter();
  const theme = useTheme();
  const { data: dashboard, isLoading, isError, refetch } = useArtistDashboard();

  const go = useCallback((href: Href) => router.push(href), [router]);

  const stat = (value: number | undefined): string => (value === undefined ? '—' : value.toLocaleString());

  return (
    <ScreenContainer
      title={artist.name}
      subtitle="Artist studio"
      actions={
        <Button
          variant="primary"
          size="sm"
          onPress={() => go('/music/upload')}
          icon={<MaterialCommunityIcons name="plus" size={18} color="#fff" />}
        >
          Upload
        </Button>
      }
    >
      <View className="flex-row items-center gap-3 mb-6">
        <ArtistAvatar artist={artist} />
        <View className="flex-1">
          <View className="flex-row items-center gap-1.5">
            <Text numberOfLines={1} className="text-base font-semibold text-foreground">{artist.name}</Text>
            {artist.verified ? (
              <MaterialCommunityIcons name="check-decagram" size={16} color={theme.colors.primary} />
            ) : null}
          </View>
          {artist.genres && artist.genres.length > 0 ? (
            <Text numberOfLines={1} className="text-xs text-muted-foreground mt-0.5">{artist.genres.join(' · ')}</Text>
          ) : null}
        </View>
      </View>

      {dashboard?.uploadsDisabled ? (
        <View className="flex-row gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 mb-4">
          <MaterialCommunityIcons name="alert-circle" size={22} color={theme.colors.error} />
          <Text className="text-sm text-foreground flex-1">
            Uploads are disabled due to copyright strikes. Contact support for more information.
          </Text>
        </View>
      ) : null}

      <View className="flex-row gap-3 mb-3">
        <StatTile icon="music-note" label="Tracks" value={stat(dashboard?.totalTracks)} />
        <StatTile icon="album" label="Albums" value={stat(dashboard?.totalAlbums)} />
      </View>
      <View className="flex-row gap-3 mb-6">
        <StatTile icon="play-circle-outline" label="Plays" value={stat(dashboard?.totalPlays)} />
        <StatTile icon="heart-outline" label="Followers" value={stat(dashboard?.followers)} />
      </View>

      <View className="gap-2 mb-6">
        <ActionCard icon="cloud-upload-outline" label="Upload song" hint="Add a track to your catalog" onPress={() => go('/music/upload')} />
        <ActionCard icon="album" label="Create album" hint="Group tracks into a release" onPress={() => go('/music/album/new')} />
        <ActionCard icon="chart-line" label="Insights" hint="Plays, listeners, and top tracks" onPress={() => go('/music/insights')} />
      </View>

      {isLoading ? (
        <View className="py-10 items-center">
          <Loading />
        </View>
      ) : isError ? (
        <View className="py-10 items-center px-6">
          <Text className="text-base text-foreground mb-3">Couldn&apos;t load your studio.</Text>
          <Button variant="secondary" onPress={() => refetch()}>Retry</Button>
        </View>
      ) : dashboard ? (
        <>
          <Text className="text-base font-semibold text-foreground mb-3">Recent tracks</Text>
          {dashboard.recentTracks.length === 0 ? (
            <View className="rounded-2xl border border-border bg-surface px-4 py-8 items-center mb-6">
              <Text className="text-sm text-muted-foreground mb-3">No tracks yet.</Text>
              <Button variant="secondary" size="sm" onPress={() => go('/music/upload')}>Upload your first song</Button>
            </View>
          ) : (
            <View className="gap-2 mb-6">
              {dashboard.recentTracks.map((track) => (
                <View key={track.id} className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
                  <View className="w-9 h-9 rounded-lg bg-primary/10 items-center justify-center">
                    <MaterialCommunityIcons name="music-note" size={18} color={theme.colors.primary} />
                  </View>
                  <Text numberOfLines={1} className="text-sm font-medium text-foreground flex-1">{track.title}</Text>
                  <Text className="text-xs text-muted-foreground">{track.playCount.toLocaleString()} plays</Text>
                </View>
              ))}
            </View>
          )}

          <Text className="text-base font-semibold text-foreground mb-3">Recent albums</Text>
          {dashboard.recentAlbums.length === 0 ? (
            <View className="rounded-2xl border border-border bg-surface px-4 py-8 items-center">
              <Text className="text-sm text-muted-foreground mb-3">No albums yet.</Text>
              <Button variant="secondary" size="sm" onPress={() => go('/music/album/new')}>Create an album</Button>
            </View>
          ) : (
            <View className="gap-2">
              {dashboard.recentAlbums.map((album) => (
                <View key={album.id} className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
                  <View className="w-9 h-9 rounded-lg bg-primary/10 items-center justify-center">
                    <MaterialCommunityIcons name="album" size={18} color={theme.colors.primary} />
                  </View>
                  <Text numberOfLines={1} className="text-sm font-medium text-foreground flex-1">{album.title}</Text>
                  <Text className="text-xs text-muted-foreground">
                    {album.totalTracks} {album.totalTracks === 1 ? 'track' : 'tracks'}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </>
      ) : null}
    </ScreenContainer>
  );
}

function MusicStudio() {
  const router = useRouter();
  const { data: artist, isLoading } = useMyArtistProfile();

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Loading />
      </View>
    );
  }

  if (!artist) {
    return <BecomeArtistEmptyState onRegister={() => router.push('/music/register')} />;
  }

  return <StudioDashboard artist={artist} />;
}

export default function MusicScreen() {
  return (
    <SignInGate>
      <MusicStudio />
    </SignInGate>
  );
}
