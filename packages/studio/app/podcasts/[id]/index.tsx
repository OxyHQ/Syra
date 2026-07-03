import { useCallback } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Button } from '@oxyhq/bloom/button';
import { Loading } from '@oxyhq/bloom/loading';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { Artwork } from '@/components/Artwork';
import { StatusBadge } from '@/components/StatusBadge';
import { CopyableField } from '@/components/CopyableField';
import { EpisodeRow } from '@/components/EpisodeRow';
import { usePodcast } from '@/hooks/usePodcasts';
import { podcastRssUrl } from '@/services/podcastService';

function ShowDetail({ id }: { id: string }) {
  const router = useRouter();
  const { data, isLoading, isError, refetch } = usePodcast(id);

  const goToUpload = useCallback(
    () => router.push({ pathname: '/podcasts/[id]/upload', params: { id } }),
    [router, id],
  );

  if (isLoading) {
    return (
      <ScreenContainer onBack={() => router.back()}>
        <View className="py-16 items-center">
          <Loading />
        </View>
      </ScreenContainer>
    );
  }

  if (isError || !data) {
    return (
      <ScreenContainer title="Show" onBack={() => router.back()}>
        <View className="py-16 items-center px-6">
          <Text className="text-base text-foreground mb-3">Couldn&apos;t load this podcast.</Text>
          <Button variant="secondary" onPress={() => refetch()}>Retry</Button>
        </View>
      </ScreenContainer>
    );
  }

  const { podcast, episodes } = data;

  return (
    <ScreenContainer
      title={podcast.title}
      subtitle={podcast.author ?? undefined}
      onBack={() => router.back()}
      actions={
        <Button variant="primary" size="sm" onPress={goToUpload} icon={<MaterialCommunityIcons name="upload" size={18} color="#fff" />}>
          Upload
        </Button>
      }
    >
      <View className="flex-row gap-4 mb-6">
        <Artwork uri={podcast.image} size={96} rounded="2xl" />
        <View className="flex-1 justify-center gap-2">
          <View className="flex-row items-center gap-2">
            <StatusBadge status={podcast.status} />
            <Text className="text-xs text-muted-foreground capitalize">{podcast.type}</Text>
          </View>
          <Text className="text-sm text-muted-foreground">
            {podcast.episodeCount} {podcast.episodeCount === 1 ? 'episode' : 'episodes'}
          </Text>
          {podcast.description ? (
            <Text numberOfLines={3} className="text-sm text-foreground/80">
              {podcast.description}
            </Text>
          ) : null}
        </View>
      </View>

      <View className="mb-6">
        <CopyableField label="Public RSS feed" value={podcastRssUrl(podcast)} />
        <Text className="text-xs text-muted-foreground mt-1.5">
          Submit this URL to Apple Podcasts, Spotify, and other directories to publish everywhere.
        </Text>
      </View>

      <Text className="text-base font-semibold text-foreground mb-1">Episodes</Text>
      {episodes.length === 0 ? (
        <View className="items-center py-12">
          <MaterialCommunityIcons name="playlist-music-outline" size={36} color="#9ca3af" />
          <Text className="text-sm text-muted-foreground mt-2 mb-4">No episodes yet.</Text>
          <Button variant="secondary" onPress={goToUpload}>Upload your first episode</Button>
        </View>
      ) : (
        <View>
          {episodes.map((episode) => (
            <EpisodeRow key={episode.id} episode={episode} />
          ))}
        </View>
      )}
    </ScreenContainer>
  );
}

export default function ShowDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <SignInGate>
      {id ? <ShowDetail id={id} /> : null}
    </SignInGate>
  );
}
