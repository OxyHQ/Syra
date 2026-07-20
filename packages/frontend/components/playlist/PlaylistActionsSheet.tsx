import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import BottomSheet, { type BottomSheetRef } from '@oxyhq/bloom/bottom-sheet';
import { AlertDialog } from '@oxyhq/bloom/alert-dialog';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { useOxy } from '@oxyhq/services';
import type { Playlist } from '@syra/shared-types';
import { useDeletePlaylist, useUpdatePlaylist } from '@/hooks/usePlaylistMutations';
import { EmptyState } from '@/components/common/EmptyState';
import { toast } from '@/lib/sonner';

interface PlaylistActionsSheetProps {
  visible: boolean;
  onClose: () => void;
  playlist: Playlist;
  /** Called after a successful delete so the screen can navigate away. */
  onDeleted: () => void;
}

type Mode = 'menu' | 'rename';

/**
 * Overflow menu for a playlist: rename and delete.
 *
 * Edit rights are checked here only to avoid offering an action that is certain
 * to 403 — the backend remains the authority (owner-or-collaborator to edit,
 * owner-only to delete). Viewers get an explanatory line instead of a dead menu.
 */
export const PlaylistActionsSheet: React.FC<PlaylistActionsSheetProps> = ({
  visible,
  onClose,
  playlist,
  onDeleted,
}) => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user, canUsePrivateApi, openAccountDialog } = useOxy();
  const sheetRef = useRef<BottomSheetRef>(null);
  const [mode, setMode] = useState<Mode>('menu');
  const [name, setName] = useState(playlist.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const updatePlaylist = useUpdatePlaylist();
  const deletePlaylist = useDeletePlaylist();

  const isOwner = user?.id === playlist.ownerOxyUserId;
  const canEdit = isOwner
    || (playlist.collaborators ?? []).some(
      (collaborator) => collaborator.oxyUserId === user?.id && collaborator.role === 'editor',
    );

  useEffect(() => {
    if (visible) {
      sheetRef.current?.present();
    } else {
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  /**
   * Reset on close, not on open: reopening must start from the menu with the
   * current name rather than whatever was typed last time. Doing it here rather
   * than in an effect keyed on `visible` keeps setState out of an effect body —
   * `onDismiss` fires on EVERY close path (pan-down, backdrop, and the
   * programmatic `dismiss()` below), so no route back to the menu is missed.
   */
  const handleDismiss = useCallback(() => {
    setMode('menu');
    setName(playlist.name);
    onClose();
  }, [onClose, playlist.name]);

  const handleRenameSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(t('playlistActions.nameEmpty'));
      return;
    }
    if (trimmed === playlist.name) {
      onClose();
      return;
    }
    updatePlaylist.mutate(
      { playlistId: playlist.id, updates: { name: trimmed } },
      {
        onSuccess: () => {
          toast.success(t('playlistActions.renamed'));
          onClose();
        },
      },
    );
  };

  const handleDeleteConfirmed = () => {
    setConfirmingDelete(false);
    deletePlaylist.mutate(
      { playlistId: playlist.id },
      {
        onSuccess: () => {
          toast.success(`Deleted "${playlist.name}"`);
          onClose();
          onDeleted();
        },
      },
    );
  };

  return (
    <>
      <BottomSheet ref={sheetRef} onDismiss={handleDismiss} enablePanDownToClose>
        <View style={styles.sheet}>
          <Text style={[styles.playlistName, { color: theme.colors.text }]} numberOfLines={1}>
            {playlist.name}
          </Text>

          {mode === 'rename' ? (
            <View style={styles.renameBlock}>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder={t('playlistActions.namePlaceholder')}
                placeholderTextColor={theme.colors.textSecondary}
                style={[
                  styles.input,
                  {
                    color: theme.colors.text,
                    backgroundColor: theme.colors.backgroundTertiary,
                    borderColor: theme.colors.border,
                  },
                ]}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleRenameSubmit}
                maxLength={120}
              />
              <View style={styles.renameActions}>
                <Pressable
                  style={styles.secondaryButton}
                  onPress={() => setMode('menu')}
                  accessibilityRole="button"
                >
                  <Text style={[styles.secondaryButtonText, { color: theme.colors.text }]}>
                    {t('common.cancel')}
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.primaryButton, { backgroundColor: theme.colors.primary }]}
                  onPress={handleRenameSubmit}
                  disabled={updatePlaylist.isPending}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: updatePlaylist.isPending }}
                >
                  <Text style={[styles.primaryButtonText, { color: theme.colors.primaryForeground }]}>
                    {updatePlaylist.isPending ? t('common.saving') : t('common.save')}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : canEdit ? (
            <>
              <Pressable
                style={styles.action}
                onPress={() => setMode('rename')}
                accessibilityRole="button"
              >
                <Ionicons name="pencil-outline" size={22} color={theme.colors.text} />
                <Text style={[styles.actionText, { color: theme.colors.text }]}>{t('common.rename')}</Text>
              </Pressable>

              {isOwner && (
                <Pressable
                  style={styles.action}
                  onPress={() => setConfirmingDelete(true)}
                  disabled={deletePlaylist.isPending}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: deletePlaylist.isPending }}
                >
                  <Ionicons name="trash-outline" size={22} color={theme.colors.error} />
                  <Text style={[styles.actionText, { color: theme.colors.error }]}>
                    {t('playlistActions.delete')}
                  </Text>
                </Pressable>
              )}
            </>
          ) : !canUsePrivateApi ? (
            <EmptyState
              icon={{ name: 'lock-closed-outline', size: 30 }}
              subtitle={t('playlistActions.signInSubtitle')}
              action={{
                label: t('common.signIn'),
                onPress: () => openAccountDialog('signin'),
                icon: 'log-in-outline',
              }}
              containerStyle={styles.stateContainer}
            />
          ) : (
            <Text style={[styles.viewerNote, { color: theme.colors.textSecondary }]}>
              {t('playlistActions.readOnly')}
            </Text>
          )}
        </View>
      </BottomSheet>

      <AlertDialog
        visible={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title={`Delete "${playlist.name}"?`}
        description={t('playlistActions.deleteDescription')}
        confirmLabel="Delete"
        cancelLabel="Keep"
        destructive
        onConfirm={handleDeleteConfirmed}
      />
    </>
  );
};

const styles = StyleSheet.create({
  sheet: {
    paddingHorizontal: 16,
    paddingBottom: 28,
  },
  playlistName: {
    fontSize: 17,
    fontWeight: '700',
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
  stateContainer: {
    flex: 0,
    paddingVertical: 16,
    backgroundColor: 'transparent',
  },
  viewerNote: {
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: 12,
  },
  renameBlock: {
    gap: 12,
  },
  input: {
    height: 46,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  renameActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  secondaryButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 20,
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  primaryButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 20,
  },
  primaryButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
