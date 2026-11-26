import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { AlertDialog } from '@oxy.so/bloom/alert-dialog';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import type { Episode } from '@syra/shared-types';
import { Artwork } from '@/components/Artwork';
import { StatusBadge } from '@/components/StatusBadge';
import { useDeleteEpisode } from '@/hooks/usePodcasts';
import { getApiErrorMessage } from '@/utils/api';
import { formatDate, formatDuration } from '@/utils/format';
import { createTokenStyles } from '@oxy.so/bloom/theme';

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
export function EpisodeRow({
  episode,
  deletable = false,
}: {
  episode: Episode;
  deletable?: boolean;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const [confirming, setConfirming] = useState(false);
  const { mutate: deleteEpisode, isPending } = useDeleteEpisode();

  const meta = [formatDate(episode.pubDate), formatDuration(episode.duration)]
    .filter(Boolean)
    .join(' · ');

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
      <View style={styles.row}>
        <Artwork uri={episode.image} size={48} rounded="lg" />
        <View style={styles.fill}>
          <Text numberOfLines={1} style={styles.text}>
            {episode.title}
          </Text>
          {meta ? <Text style={styles.mutedText}>{meta}</Text> : null}
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
            style={({ pressed }) => [
              styles.delete,
              pressed && styles.deletePressed,
              isPending && styles.deleteDisabled,
            ]}
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
          open={confirming}
          onOpenChange={setConfirming}
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

const useStyles = createTokenStyles((t) => ({
  delete: { borderRadius: 9999, padding: 8 },
  deletePressed: { opacity: 0.6 },
  deleteDisabled: { opacity: 0.4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderColor: t.border,
    paddingVertical: 12,
  },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  text: { fontSize: 14, fontWeight: 500, color: t.foreground, lineHeight: 20 },
  mutedText: { marginTop: 2, fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
}));
