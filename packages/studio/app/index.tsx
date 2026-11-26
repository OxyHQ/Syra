import { useCallback } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { ShowCard } from '@/components/ShowCard';
import { useMyPodcasts } from '@/hooks/usePodcasts';
import { createTokenStyles, tokenAlpha } from '@oxy.so/bloom/theme';

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.centered}>
      <View style={styles.centered2}>
        <MaterialCommunityIcons name="microphone-plus" size={30} color={theme.colors.primary} />
      </View>
      <Text style={styles.title}>No podcasts yet</Text>
      <Text style={styles.mutedText}>
        Create your first podcast to start uploading episodes and get a public RSS feed.
      </Text>
      <Button onPress={onCreate} tone="accent" appearance="solid">
        Create your first podcast
      </Button>
    </View>
  );
}

function Dashboard() {
  const styles = useStyles();
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
        <Button
          size="sm"
          onPress={goToNew}
          icon={<MaterialCommunityIcons name="plus" size={18} color="#fff" />}
          tone="accent"
          appearance="solid"
        >
          New podcast
        </Button>
      }
    >
      {isLoading ? (
        <View style={styles.container}>
          <Loading />
        </View>
      ) : isError ? (
        <View style={styles.container2}>
          <Text style={styles.text}>Couldn&apos;t load your podcasts.</Text>
          <Button onPress={() => refetch()} tone="neutral" appearance="outline">
            Retry
          </Button>
        </View>
      ) : !podcasts || podcasts.length === 0 ? (
        <EmptyState onCreate={goToNew} />
      ) : (
        <View style={styles.stack}>
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

const useStyles = createTokenStyles((t) => ({
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 64,
  },
  centered2: {
    marginBottom: 16,
    height: 64,
    width: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: tokenAlpha(t.primary, 0.1),
  },
  title: { marginBottom: 4, fontSize: 18, fontWeight: 600, color: t.foreground, lineHeight: 28 },
  mutedText: {
    marginBottom: 20,
    maxWidth: 360,
    textAlign: 'center',
    fontSize: 14,
    color: t.mutedForeground,
    lineHeight: 20,
  },
  container: { alignItems: 'center', paddingVertical: 64 },
  container2: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 64 },
  text: { marginBottom: 12, fontSize: 16, color: t.foreground, lineHeight: 24 },
  stack: { gap: 12 },
}));
