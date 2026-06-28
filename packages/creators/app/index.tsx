import { useCallback } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Button } from '@oxyhq/bloom/button';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { ShowCard } from '@/components/ShowCard';
import { useMyPodcasts } from '@/hooks/usePodcasts';

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const theme = useTheme();
  return (
    <View className="items-center justify-center py-16 px-6">
      <View className="w-16 h-16 rounded-2xl bg-primary/10 items-center justify-center mb-4">
        <MaterialCommunityIcons name="microphone-plus" size={30} color={theme.colors.primary} />
      </View>
      <Text className="text-lg font-semibold text-foreground mb-1">No podcasts yet</Text>
      <Text className="text-sm text-muted-foreground text-center mb-5 max-w-[360px]">
        Create your first podcast to start uploading episodes and get a public RSS feed.
      </Text>
      <Button variant="primary" onPress={onCreate}>Create your first podcast</Button>
    </View>
  );
}

function Dashboard() {
  const router = useRouter();
  const { data: podcasts, isLoading, isError, refetch } = useMyPodcasts();

  const goToNew = useCallback(() => router.push('/podcasts/new'), [router]);
  const openShow = useCallback(
    (id: string) => router.push({ pathname: '/podcasts/[id]', params: { id } }),
    [router],
  );

  return (
    <ScreenContainer
      title="Your podcasts"
      subtitle="Manage your podcasts and episodes"
      actions={
        <Button variant="primary" size="sm" onPress={goToNew} icon={<MaterialCommunityIcons name="plus" size={18} color="#fff" />}>
          New podcast
        </Button>
      }
    >
      {isLoading ? (
        <View className="py-16 items-center">
          <Loading />
        </View>
      ) : isError ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base text-foreground mb-3">Couldn&apos;t load your podcasts.</Text>
          <Button variant="secondary" onPress={() => refetch()}>Retry</Button>
        </View>
      ) : !podcasts || podcasts.length === 0 ? (
        <EmptyState onCreate={goToNew} />
      ) : (
        <View className="gap-3">
          {podcasts.map((podcast) => (
            <ShowCard key={podcast.id} podcast={podcast} onPress={() => openShow(podcast.id)} />
          ))}
        </View>
      )}
    </ScreenContainer>
  );
}

export default function DashboardScreen() {
  return (
    <SignInGate>
      <Dashboard />
    </SignInGate>
  );
}
