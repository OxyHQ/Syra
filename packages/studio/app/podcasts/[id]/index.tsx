import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useOxy } from '@oxy.so/services/ui/client';
import { AlertDialog } from '@oxy.so/bloom/alert-dialog';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { toast } from '@oxy.so/bloom/toast';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { Artwork } from '@/components/Artwork';
import { StatusBadge } from '@/components/StatusBadge';
import { CopyableField } from '@/components/CopyableField';
import { EpisodeRow } from '@/components/EpisodeRow';
import { useDeletePodcast, usePodcast } from '@/hooks/usePodcasts';
import { podcastRssUrl } from '@/services/podcastService';
import { getApiErrorMessage } from '@/utils/api';
import { pluralEpisodes } from '@/utils/format';
import { createTokenStyles, tokenAlpha } from '@oxy.so/bloom/theme';

function ShowDetail({ id }: { id: string }) {
  const styles = useStyles();
  const router = useRouter();
  const { user } = useOxy();
  const { data, isLoading, isError, refetch } = usePodcast(id);
  const { mutate: deleteShow, isPending: isDeleting } = useDeletePodcast();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const goToUpload = useCallback(
    () => router.push({ pathname: '/podcasts/[id]/upload', params: { id } }),
    [router, id],
  );
  const goToGenerate = useCallback(
    () => router.push({ pathname: '/podcasts/[id]/generate', params: { id } }),
    [router, id],
  );

  const title = data?.podcast.title ?? '';

  /**
   * Fires only from the dialog's confirm action — the button beside the copy
   * below opens the dialog and does nothing else, so no single press can
   * destroy a show.
   */
  const onConfirmDelete = useCallback(() => {
    setConfirmingDelete(false);
    deleteShow(id, {
      onSuccess: () => {
        toast.success(`Deleted “${title}”`);
        router.replace('/');
      },
      onError: (error) => {
        toast.error(getApiErrorMessage(error, 'Could not delete this show. Please try again.'));
      },
    });
  }, [deleteShow, id, router, title]);

  if (isLoading) {
    return (
      <ScreenContainer onBack={() => router.back()}>
        <View style={styles.container}>
          <Loading />
        </View>
      </ScreenContainer>
    );
  }

  if (isError || !data) {
    return (
      <ScreenContainer title="Show" onBack={() => router.back()}>
        <View style={styles.container2}>
          <Text style={styles.text}>Couldn&apos;t load this podcast.</Text>
          <Button onPress={() => refetch()} tone="neutral" appearance="outline">
            Retry
          </Button>
        </View>
      </ScreenContainer>
    );
  }

  const { podcast, episodes } = data;

  /**
   * Whether to offer the destructive controls at all — the client-side reading
   * of the SAME rule `loadOwnedShowOrRespond` applies in SQL, and the server's
   * is the one that decides. An RSS-mirrored show belongs to the catalogue and
   * to no user, a platform takedown is a moderation record the creator does not
   * get to erase, and everyone else's show is a 403. Hiding the control only
   * avoids offering an action that is certain to be refused; it is not the
   * check.
   *
   * `getPodcast` is a VIEWER read, not an owner read, so a creator who reaches
   * another creator's public show by its studio URL lands on this screen with a
   * show they do not own — which is what the `ownerOxyUserId` term covers.
   * `Boolean(user?.id)` guards the case where both sides are undefined, since
   * an unowned show and a signed-out viewer would otherwise compare equal.
   */
  const owned =
    podcast.source === 'syra' &&
    podcast.status !== 'removed' &&
    Boolean(user?.id) &&
    podcast.ownerOxyUserId === user?.id;

  /**
   * What the delete destroys, named. `episodeCount` is the show's own counter
   * rather than `episodes.length`, which is only the page the screen happens to
   * be holding — a creator must not be told they are deleting 20 episodes when
   * the show has 200.
   */
  const destroys =
    podcast.episodeCount > 0
      ? `“${podcast.title}”, its ${pluralEpisodes(podcast.episodeCount)} and their audio`
      : `“${podcast.title}”`;

  return (
    <ScreenContainer
      title={podcast.title}
      subtitle={podcast.author ?? undefined}
      onBack={() => router.back()}
      actions={
        <View style={styles.row}>
          {owned ? (
            <Button
              size="sm"
              onPress={goToGenerate}
              icon={<MaterialCommunityIcons name="creation" size={18} />}
              tone="neutral"
              appearance="outline"
              testID="generate-episode-link"
            >
              Generate
            </Button>
          ) : null}
          <Button
            size="sm"
            onPress={goToUpload}
            icon={<MaterialCommunityIcons name="upload" size={18} color="#fff" />}
            tone="accent"
            appearance="solid"
          >
            Upload
          </Button>
        </View>
      }
    >
      <View style={styles.row2}>
        <Artwork uri={podcast.image} size={96} rounded="2xl" />
        <View style={styles.container3}>
          <View style={styles.row3}>
            <StatusBadge status={podcast.status} />
            <Text style={styles.mutedText}>{podcast.type}</Text>
          </View>
          <Text style={styles.mutedText2}>{pluralEpisodes(podcast.episodeCount)}</Text>
          {podcast.description ? (
            <Text numberOfLines={3} style={styles.text2}>
              {podcast.description}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.section}>
        <CopyableField label="Public RSS feed" value={podcastRssUrl(podcast)} />
        <Text style={styles.mutedText3}>
          Submit this URL to Apple Podcasts, Spotify, and other directories to publish everywhere.
        </Text>
      </View>

      <Text style={styles.title}>Episodes</Text>
      {episodes.length === 0 ? (
        <View style={styles.container4}>
          <MaterialCommunityIcons name="playlist-music-outline" size={36} color="#9ca3af" />
          <Text style={styles.mutedText4}>No episodes yet.</Text>
          <Button onPress={goToUpload} tone="neutral" appearance="outline">
            Upload your first episode
          </Button>
        </View>
      ) : (
        <View>
          {episodes.map((episode) => (
            <EpisodeRow key={episode.id} episode={episode} deletable={owned} />
          ))}
        </View>
      )}

      {owned ? (
        <>
          <View style={styles.container5}>
            <Text style={styles.title2}>Delete this show</Text>
            <Text style={styles.mutedText5}>
              Permanently removes {destroys}, every subscription and every listener&apos;s saved
              position. The public RSS feed stops working. This cannot be undone.
            </Text>
            <View style={styles.container6}>
              <Button
                size="sm"
                onPress={() => setConfirmingDelete(true)}
                disabled={isDeleting}
                loading={isDeleting}
                testID="delete-show-button"
                icon={<MaterialCommunityIcons name="trash-can-outline" size={16} color="#fff" />}
                tone="danger"
                appearance="solid"
              >
                Delete show
              </Button>
            </View>
          </View>

          <AlertDialog
            open={confirmingDelete}
            onOpenChange={setConfirmingDelete}
            title={`Delete “${podcast.title}”?`}
            description={`This permanently removes ${destroys}, every subscription and every listener's saved position. The RSS feed stops working, and none of it can be restored.`}
            confirmLabel="Delete forever"
            cancelLabel="Keep show"
            destructive
            testID="delete-show-dialog"
            onConfirm={onConfirmDelete}
          />
        </>
      ) : null}
    </ScreenContainer>
  );
}

export default function ShowDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SignInGate>{id ? <ShowDetail id={id} /> : null}</SignInGate>;
}

const useStyles = createTokenStyles((t) => ({
  container: { alignItems: 'center', paddingVertical: 64 },
  container2: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 64 },
  text: { marginBottom: 12, fontSize: 16, color: t.foreground, lineHeight: 24 },
  row: { flexDirection: 'row', gap: 8 },
  row2: { marginBottom: 24, flexDirection: 'row', gap: 16 },
  container3: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', justifyContent: 'center', gap: 8 },
  row3: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mutedText: {
    fontSize: 12,
    color: t.mutedForeground,
    textTransform: 'capitalize',
    lineHeight: 16,
  },
  mutedText2: { fontSize: 14, color: t.mutedForeground, lineHeight: 20 },
  text2: { fontSize: 14, color: tokenAlpha(t.foreground, 0.8), lineHeight: 20 },
  section: { marginBottom: 24 },
  mutedText3: { marginTop: 6, fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
  title: { marginBottom: 4, fontSize: 16, fontWeight: 600, color: t.foreground, lineHeight: 24 },
  container4: { alignItems: 'center', paddingVertical: 48 },
  mutedText4: {
    marginTop: 8,
    marginBottom: 16,
    fontSize: 14,
    color: t.mutedForeground,
    lineHeight: 20,
  },
  container5: {
    marginTop: 40,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: tokenAlpha(t.destructive, 0.4),
    padding: 16,
  },
  title2: { marginBottom: 4, fontSize: 14, fontWeight: 600, color: t.foreground, lineHeight: 20 },
  mutedText5: { marginBottom: 16, fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
  container6: { alignSelf: 'flex-start' },
}));
