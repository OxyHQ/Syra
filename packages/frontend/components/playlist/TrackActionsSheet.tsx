import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import BottomSheet, { type BottomSheetRef } from '@oxyhq/bloom/bottom-sheet';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import type { Track } from '@syra/shared-types';
import { useRemoveTracksFromPlaylist } from '@/hooks/usePlaylistMutations';
import { AddToPlaylistSheet } from '@/components/playlist/AddToPlaylistSheet';
import { toast } from '@/lib/sonner';

interface TrackActionsSheetProps {
  visible: boolean;
  onClose: () => void;
  track: Track;
  /**
   * Set when the sheet is opened from inside a playlist the user can edit —
   * that's the only context where "remove from this playlist" is meaningful.
   */
  removeFrom?: { playlistId: string; playlistName: string };
}

/**
 * Per-track overflow menu: open this track's radio station, add it to a
 * playlist, and remove it from the current one.
 *
 * Removal is not confirmed. It's a single, instantly reversible action (the
 * track is one tap from being re-added) and the row disappears optimistically —
 * a modal for it would be friction, unlike deleting a whole playlist.
 */
export const TrackActionsSheet: React.FC<TrackActionsSheetProps> = ({
  visible,
  onClose,
  track,
  removeFrom,
}) => {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const sheetRef = useRef<BottomSheetRef>(null);
  const [addingToPlaylist, setAddingToPlaylist] = useState(false);
  const removeTracks = useRemoveTracksFromPlaylist();

  useEffect(() => {
    if (visible) {
      sheetRef.current?.present();
    } else {
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  const handleRemove = () => {
    if (!removeFrom) {
      return;
    }
    removeTracks.mutate(
      { playlistId: removeFrom.playlistId, trackIds: [track.id] },
      {
        onSuccess: () => {
          toast.success(`Removed from ${removeFrom.playlistName}`);
        },
      },
    );
    onClose();
  };

  return (
    <>
      <BottomSheet ref={sheetRef} onDismiss={onClose} enablePanDownToClose>
        <View style={styles.sheet}>
          <Text style={[styles.trackTitle, { color: theme.colors.text }]} numberOfLines={1}>
            {track.title}
          </Text>
          <Text style={[styles.trackArtist, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {track.artistName}
          </Text>

          <Pressable
            style={styles.action}
            onPress={() => {
              router.push({ pathname: '/radio/[...seed]', params: { seed: ['track', track.id] } });
              onClose();
            }}
            accessibilityRole="button"
          >
            <Ionicons name="radio-outline" size={22} color={theme.colors.text} />
            <Text style={[styles.actionText, { color: theme.colors.text }]}>{t('radio.songRadio')}</Text>
          </Pressable>

          <Pressable
            style={styles.action}
            onPress={() => setAddingToPlaylist(true)}
            accessibilityRole="button"
          >
            <Ionicons name="add-circle-outline" size={22} color={theme.colors.text} />
            <Text style={[styles.actionText, { color: theme.colors.text }]}>{t('trackActions.addToPlaylist')}</Text>
          </Pressable>

          {removeFrom && (
            <Pressable
              style={styles.action}
              onPress={handleRemove}
              disabled={removeTracks.isPending}
              accessibilityRole="button"
              accessibilityState={{ disabled: removeTracks.isPending }}
            >
              <Ionicons name="remove-circle-outline" size={22} color={theme.colors.error} />
              <Text style={[styles.actionText, { color: theme.colors.error }]}>
                {t('trackActions.removeFromPlaylist')}
              </Text>
            </Pressable>
          )}
        </View>
      </BottomSheet>

      <AddToPlaylistSheet
        visible={addingToPlaylist}
        onClose={() => {
          setAddingToPlaylist(false);
          onClose();
        }}
        tracks={[track]}
        excludePlaylistId={removeFrom?.playlistId}
      />
    </>
  );
};

const styles = StyleSheet.create({
  sheet: {
    paddingHorizontal: 16,
    paddingBottom: 28,
  },
  trackTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  trackArtist: {
    fontSize: 14,
    marginTop: 2,
    marginBottom: 12,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    minHeight: 52,
  },
  actionText: {
    fontSize: 16,
    fontWeight: '500',
  },
});
