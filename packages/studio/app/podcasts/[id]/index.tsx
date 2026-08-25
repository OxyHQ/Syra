import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useOxy } from '@oxyhq/services';
import { AlertDialog } from '@oxyhq/bloom/alert-dialog';
import { Button } from '@oxyhq/bloom/button';
import { Loading } from '@oxyhq/bloom/loading';
import { toast } from '@oxyhq/bloom/toast';
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

function ShowDetail({ id }: { id: string }) {
  const router = useRouter();
  const { user } = useOxy();
  const { data, isLoading, isError, refetch } = usePodcast(id);
  const { mutate: deleteShow, isPending: isDeleting } = useDeletePodcast();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const goToUpload = useCallback(
    () => router.push({ pathname: '/podcasts/[id]/upload', params: { id } }),
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
          <Text className="text-sm text-muted-foreground">{pluralEpisodes(podcast.episodeCount)}</Text>
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
            <EpisodeRow key={episode.id} episode={episode} deletable={owned} />
          ))}
        </View>
      )}

      {owned ? (
        <>
          <View className="mt-10 rounded-2xl border border-destructive/40 p-4">
            <Text className="text-sm font-semibold text-foreground mb-1">Delete this show</Text>
            <Text className="text-xs text-muted-foreground mb-4">
              Permanently removes {destroys}, every subscription and every listener&apos;s saved
              position. The public RSS feed stops working. This cannot be undone.
            </Text>
            <View className="self-start">
              <Button
                variant="destructive"
                size="sm"
                onPress={() => setConfirmingDelete(true)}
                disabled={isDeleting}
                loading={isDeleting}
                testID="delete-show-button"
                icon={<MaterialCommunityIcons name="trash-can-outline" size={16} color="#fff" />}
              >
                Delete show
              </Button>
            </View>
          </View>

          <AlertDialog
            visible={confirmingDelete}
            onClose={() => setConfirmingDelete(false)}
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
  return (
    <SignInGate>
      {id ? <ShowDetail id={id} /> : null}
    </SignInGate>
  );
}
