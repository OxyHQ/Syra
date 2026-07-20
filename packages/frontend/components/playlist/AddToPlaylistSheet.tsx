import React, { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import BottomSheet, { type BottomSheetRef } from '@oxyhq/bloom/bottom-sheet';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import type { Track } from '@syra/shared-types';
import { musicService } from '@/services/musicService';
import { useAddTracksToPlaylist } from '@/hooks/usePlaylistMutations';
import { pickCatalogImageUrl } from '@/utils/pickImage';
import { EmptyState } from '@/components/common/EmptyState';
import { LibraryListSkeleton } from '@/components/skeletons';
import { toast } from '@/lib/sonner';

interface AddToPlaylistSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Tracks to add. Passing the full objects lets the target list update optimistically. */
  tracks: Track[];
  /** Playlist to exclude from the list — you can't add a playlist's tracks to itself. */
  excludePlaylistId?: string;
}

/**
 * "Add to playlist" picker.
 *
 * Lists the playlists the user can write to and adds the given tracks to the one
 * they pick. Signed-out users get a sign-in CTA rather than an empty list, since
 * `GET /playlists` is authenticated and would otherwise render as "no playlists".
 */
export const AddToPlaylistSheet: React.FC<AddToPlaylistSheetProps> = ({
  visible,
  onClose,
  tracks,
  excludePlaylistId,
}) => {
  const theme = useTheme();
  const router = useRouter();
  const { canUsePrivateApi, isPrivateApiPending, openAccountDialog } = useOxy();
  const sheetRef = useRef<BottomSheetRef>(null);
  const addTracks = useAddTracksToPlaylist();

  // The sheet is imperative; mirror the declarative `visible` onto it.
  useEffect(() => {
    if (visible) {
      sheetRef.current?.present();
    } else {
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  const playlistsQuery = useQuery({
    queryKey: ['library', 'playlists'],
    queryFn: () => musicService.getUserPlaylists(),
    enabled: visible && canUsePrivateApi,
  });

  const playlists = (playlistsQuery.data?.playlists ?? []).filter(
    (playlist) => playlist.id !== excludePlaylistId,
  );

  const handlePick = (playlistId: string, playlistName: string) => {
    const trackIds = tracks.map((track) => track.id);
    addTracks.mutate(
      { playlistId, trackIds, tracks },
      {
        onSuccess: (result) => {
          const label = result.added === 1 ? '1 song' : `${result.added} songs`;
          toast.success(
            result.skipped > 0
              ? `Added ${label} to ${playlistName} — ${result.skipped} already there`
              : `Added ${label} to ${playlistName}`,
          );
          onClose();
        },
      },
    );
  };

  const handleCreateNew = () => {
    onClose();
    router.push('/create-playlist');
  };

  const body = () => {
    if (!canUsePrivateApi) {
      return (
        <EmptyState
          icon={{ name: 'lock-closed-outline', size: 32 }}
          title="Sign in to save songs"
          subtitle="Your playlists live on your account."
          action={{ label: 'Sign in', onPress: () => openAccountDialog('signin'), icon: 'log-in-outline' }}
          containerStyle={styles.stateContainer}
        />
      );
    }

    if (isPrivateApiPending || playlistsQuery.isLoading) {
      return <LibraryListSkeleton count={4} />;
    }

    if (playlistsQuery.error) {
      return (
        <EmptyState
          icon={{ name: 'alert-circle-outline', size: 32 }}
          error={{
            title: "Couldn't load your playlists",
            message: 'Check your connection and try again.',
            onRetry: async () => { await playlistsQuery.refetch(); },
          }}
          containerStyle={styles.stateContainer}
        />
      );
    }

    if (playlists.length === 0) {
      return (
        <EmptyState
          icon={{ name: 'musical-notes-outline', size: 32 }}
          title="No playlists yet"
          subtitle="Create one and it'll show up here."
          action={{ label: 'New playlist', onPress: handleCreateNew, icon: 'add' }}
          containerStyle={styles.stateContainer}
        />
      );
    }

    return (
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {playlists.map((playlist) => {
          const cover = pickCatalogImageUrl(
            undefined,
            playlist.coverArt,
            'thumbnail',
            playlist.coverArtSizes,
          );
          return (
            <Pressable
              key={playlist.id}
              style={styles.row}
              onPress={() => handlePick(playlist.id, playlist.name)}
              disabled={addTracks.isPending}
              accessibilityRole="button"
              accessibilityLabel={`Add to ${playlist.name}`}
            >
              <View style={[styles.artwork, { backgroundColor: theme.colors.backgroundTertiary }]}>
                {cover ? (
                  <Image source={{ uri: cover }} style={styles.artworkImage} contentFit="cover" />
                ) : (
                  <Ionicons name="musical-notes" size={18} color={theme.colors.textSecondary} />
                )}
              </View>
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: theme.colors.text }]} numberOfLines={1}>
                  {playlist.name}
                </Text>
                <Text style={[styles.rowSubtitle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                  {playlist.trackCount} {playlist.trackCount === 1 ? 'song' : 'songs'}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    );
  };

  return (
    <BottomSheet ref={sheetRef} onDismiss={onClose} enablePanDownToClose>
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            {tracks.length === 1 ? 'Add to playlist' : `Add ${tracks.length} songs to playlist`}
          </Text>
          {canUsePrivateApi && (
            <Pressable
              onPress={handleCreateNew}
              style={styles.newButton}
              accessibilityRole="button"
              accessibilityLabel="Create a new playlist"
            >
              <Ionicons name="add" size={20} color={theme.colors.text} />
              <Text style={[styles.newButtonText, { color: theme.colors.text }]}>New</Text>
            </Pressable>
          )}
        </View>
        {body()}
      </View>
    </BottomSheet>
  );
};

const styles = StyleSheet.create({
  sheet: {
    paddingHorizontal: 16,
    paddingBottom: 24,
    maxHeight: 460,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    flex: 1,
    minWidth: 0,
  },
  newButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  newButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  list: {
    maxHeight: 360,
  },
  listContent: {
    paddingBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    minHeight: 60,
  },
  artwork: {
    width: 44,
    height: 44,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  artworkImage: {
    width: 44,
    height: 44,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  rowSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  stateContainer: {
    flex: 0,
    paddingVertical: 24,
    backgroundColor: 'transparent',
  },
});
