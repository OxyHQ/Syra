import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { AlertDialog } from '@oxyhq/bloom/alert-dialog';
import { useTheme } from '@oxyhq/bloom/theme';
import { toast } from '@oxyhq/bloom/toast';
import type { Episode } from '@syra/shared-types';
import { Artwork } from '@/components/Artwork';
import { StatusBadge } from '@/components/StatusBadge';
import { useDeleteEpisode } from '@/hooks/usePodcasts';
import { getApiErrorMessage } from '@/utils/api';
import { formatDate, formatDuration } from '@/utils/format';

/**
 * One episode in the show-detail list. The creator (owner) sees every status,
 * including `processing` and `failed`, so they can track ingest progress.
 *
 * `deletable` is the owner check the SCREEN already resolved, passed down
 * rather than recomputed here: this component has the episode but not the show,
 * and the show is where `source` and `ownerOxyUserId` live. It only decides
 * whether to OFFER the control — `DELETE /episodes/:id` re-derives ownership
 * from the parent show in SQL and answers 403 regardless of what was rendered.
 */
export function EpisodeRow({ episode, deletable = false }: { episode: Episode; deletable?: boolean }) {
  const theme = useTheme();
  const [confirming, setConfirming] = useState(false);
  const { mutate: deleteEpisode, isPending } = useDeleteEpisode();

  const meta = [formatDate(episode.pubDate), formatDuration(episode.duration)].filter(Boolean).join(' · ');

  const onConfirmDelete = useCallback(() => {
    setConfirming(false);
    deleteEpisode(episode.id, {
      onSuccess: () => {
        toast.success(`Deleted “${episode.title}”`);
      },
      onError: (error) => {
        toast.error(getApiErrorMessage(error, 'Could not delete this episode. Please try again.'));
      },
    });
  }, [deleteEpisode, episode.id, episode.title]);

  return (
    <>
      <View className="flex-row items-center gap-3 py-3 border-b border-border">
        <Artwork uri={episode.image} size={48} rounded="lg" />
        <View className="flex-1">
          <Text numberOfLines={1} className="text-sm font-medium text-foreground">
            {episode.title}
          </Text>
          {meta ? <Text className="text-xs text-muted-foreground mt-0.5">{meta}</Text> : null}
        </View>
        <StatusBadge status={episode.status} />
        {deletable ? (
          <Pressable
            onPress={() => setConfirming(true)}
            disabled={isPending}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${episode.title}`}
            accessibilityState={{ disabled: isPending }}
            testID={`delete-episode-${episode.id}`}
            hitSlop={8}
            className="p-2 rounded-full active:opacity-60 disabled:opacity-40"
          >
            <MaterialCommunityIcons name="trash-can-outline" size={18} color={theme.colors.error} />
          </Pressable>
        ) : null}
      </View>

      {/*
        A sibling of the row, not a child of it: the row is a flex line with a
        gap, and a surface that mounts a full-screen overlay has no business
        being one of its columns. Same shape as `PlaylistActionsSheet`.
      */}
      {deletable ? (
        <AlertDialog
          visible={confirming}
          onClose={() => setConfirming(false)}
          title={`Delete “${episode.title}”?`}
          description="This permanently removes the episode, its audio and every listener's saved position in it. It disappears from the show's RSS feed, and it cannot be restored."
          confirmLabel="Delete forever"
          cancelLabel="Keep episode"
          destructive
          testID={`delete-episode-dialog-${episode.id}`}
          onConfirm={onConfirmDelete}
        />
      ) : null}
    </>
  );
}
