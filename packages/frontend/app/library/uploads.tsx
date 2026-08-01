import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { toast } from '@oxyhq/bloom/toast';
import type { UserUploadAsTrack } from '@syra/shared-types';
import SEO from '@/components/SEO';
import { EmptyState } from '@/components/common/EmptyState';
import { LibraryListSkeleton } from '@/components/skeletons';
import { useAuthGate } from '@/hooks/useAuthGate';
import {
  useDeleteUpload,
  usePromoteUpload,
  useUpdateUpload,
  useUploadAlbums,
  useUploads,
} from '@/hooks/useUploads';
import type { UploadAlbum } from '@/services/uploadsService';
import { usePlayerStore } from '@/stores/playerStore';
import { pickCatalogImageUrl } from '@/utils/pickImage';
import { formatDuration } from '@/utils/musicUtils';
import { createScopedLogger } from '@/utils/logger';

/**
 * Your uploads (`/library/uploads`) — the private locker.
 *
 * Nothing here is catalogue. These documents live in their own collection that
 * no catalogue query reads, they are addressed as `kind: 'upload'`, and they
 * play through an endpoint that checks ownership as part of the query that loads
 * them. The screen exists so that separation is visible rather than implied.
 *
 * Two things the UI must get right, both of which look like bugs if you assume
 * catalogue rules:
 *
 *  - **A file with no artist is normal.** A locker takes exactly the material
 *    nobody catalogued, so an empty `artistName` renders as "unknown artist" —
 *    never as an error, and never as something to fix before it will play.
 *  - **Albums here are a GROUPING, not entities.** A private file must not
 *    create a catalogue `Album`, so releases come from `GET /api/uploads/albums`,
 *    an owner-scoped aggregation over the `albumKey` each file carries. The
 *    client never derives that key: it resolves the ids the server returns.
 */

const logger = createScopedLogger('UploadsScreen');

/**
 * A release from `GET /api/uploads/albums`, paired with the rows on this page.
 *
 * The SERVER owns the grouping, the ordering and the counts: it aggregates on
 * `{ownerOxyUserId, albumKey, discNumber, trackNumber}`, so the release list is
 * correct at any locker size and does not depend on how many tracks the
 * paginated list happens to have loaded. This function only resolves each
 * release's `trackIds` against the rows already in hand — it never re-derives a
 * key, a title or an order, because a second implementation of `buildAlbumKey`
 * on the client is exactly what drifts on compilations and same-titled reissues.
 *
 * `trackCount` therefore comes from the server while `tracks` is what is
 * currently renderable; on a locker larger than one page the header can honestly
 * say twelve while showing the eight that are loaded.
 */
function resolveAlbums(
  albums: UploadAlbum[],
  uploads: UserUploadAsTrack[],
): { album: UploadAlbum; tracks: UserUploadAsTrack[] }[] {
  const byId = new Map(uploads.map((upload) => [upload.id, upload]));
  return albums
    .map((album) => ({
      album,
      // `trackIds` is already ordered by disc then track number server-side.
      tracks: album.trackIds
        .map((id) => byId.get(id))
        .filter((upload): upload is UserUploadAsTrack => upload !== undefined),
    }))
    .filter((entry) => entry.tracks.length > 0);
}

/**
 * Files that belong to no release.
 *
 * `albumKey` is absent — not empty — for a file with no album tag, deliberately:
 * the key builder is a pure join and would answer `"||"` for an untagged file,
 * which a "has a key" filter would collect into one phantom album containing
 * every untagged upload in the locker.
 */
function looseUploads(uploads: UserUploadAsTrack[]): UserUploadAsTrack[] {
  return uploads.filter((upload) => !upload.albumKey);
}

/**
 * Days until a locker file is deleted, or null when it is not near expiry.
 *
 * Retention promises a warning before anything is removed, and the T−14d
 * notification cannot discharge that on its own — a listener who never opens
 * their notifications would have no way to see it. Surfaced only inside the
 * warning window, so a file with ten months left does not carry a countdown
 * that reads like a problem.
 */
const EXPIRY_WARNING_DAYS = 30;

function daysUntilExpiry(expiresAt: string | undefined): number | null {
  if (!expiresAt) {
    return null;
  }
  const due = Date.parse(expiresAt);
  if (!Number.isFinite(due)) {
    return null;
  }
  const days = Math.ceil((due - Date.now()) / (24 * 60 * 60 * 1000));
  return days <= EXPIRY_WARNING_DAYS ? Math.max(0, days) : null;
}

interface UploadRowProps {
  upload: UserUploadAsTrack;
  isCurrent: boolean;
  onPlay: () => void;
}

const UploadRow: React.FC<UploadRowProps> = ({ upload, isCurrent, onPlay }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const [title, setTitle] = useState(upload.title);
  const [artistName, setArtistName] = useState(upload.artistName);
  const [albumName, setAlbumName] = useState(upload.albumName ?? '');
  const [attestationAccepted, setAttestationAccepted] = useState(false);

  const updateUpload = useUpdateUpload();
  const deleteUpload = useDeleteUpload();
  const promoteUpload = usePromoteUpload();

  const attestationStatement = t('uploads.attestation.statement');
  const artworkUrl = pickCatalogImageUrl(upload.images, upload.coverArt, 'thumbnail', upload.coverArtSizes);
  const isPlayable = upload.status === 'ready';
  const expiringInDays = daysUntilExpiry(upload.expiresAt);
  const hasEdits =
    title !== upload.title ||
    artistName !== upload.artistName ||
    albumName !== (upload.albumName ?? '');

  const handleSave = useCallback(async () => {
    try {
      await updateUpload.mutateAsync({
        uploadId: upload.id,
        patch: {
          title: title.trim() || undefined,
          artistName: artistName.trim() || undefined,
          albumName: albumName.trim() || undefined,
        },
      });
      toast.success(t('uploads.locker.saved'));
    } catch (error) {
      logger.error('Failed to update upload', { uploadId: upload.id, error });
      toast.error(error instanceof Error ? error.message : t('uploads.locker.saveFailed'));
    }
  }, [albumName, artistName, t, title, updateUpload, upload.id]);

  const handleDelete = useCallback(async () => {
    try {
      await deleteUpload.mutateAsync(upload.id);
      toast.success(t('uploads.locker.deleted'));
    } catch (error) {
      logger.error('Failed to delete upload', { uploadId: upload.id, error });
      toast.error(error instanceof Error ? error.message : t('uploads.locker.deleteFailed'));
    }
  }, [deleteUpload, t, upload.id]);

  const handlePromote = useCallback(async () => {
    try {
      const outcome = await promoteUpload.mutateAsync({
        uploadId: upload.id,
        request: {
          title: title.trim() || undefined,
          artistName: artistName.trim() || undefined,
          albumName: albumName.trim() || undefined,
          // Verbatim as displayed: the attestation is evidence this person
          // agreed to THIS text, so a different string would prove nothing.
          attestation: attestationStatement,
        },
      });

      // A refusal comes back as a normal outcome, not a rejection — surface the
      // reason rather than a generic failure, because the reason is the point.
      if (outcome.outcome === 'blocked') {
        toast.error(outcome.message);
        return;
      }
      toast.success(t('uploads.locker.contributed'));
    } catch (error) {
      logger.error('Failed to promote upload', { uploadId: upload.id, error });
      toast.error(error instanceof Error ? error.message : t('uploads.locker.contributeFailed'));
    }
  }, [albumName, artistName, attestationStatement, promoteUpload, t, title, upload.id]);

  return (
    <View style={[styles.row, { backgroundColor: theme.colors.backgroundTertiary }]}>
      <Pressable
        style={styles.rowMain}
        onPress={onPlay}
        disabled={!isPlayable}
        accessibilityRole="button"
      >
        {artworkUrl ? (
          <Image source={{ uri: artworkUrl }} style={styles.artwork} contentFit="cover" />
        ) : (
          <View style={[styles.artwork, styles.artworkPlaceholder, { backgroundColor: theme.colors.backgroundSecondary }]}>
            <Ionicons name="musical-note" size={18} color={theme.colors.textSecondary} />
          </View>
        )}

        <View style={styles.rowText}>
          <Text
            style={[styles.rowTitle, { color: isCurrent ? theme.colors.primary : theme.colors.text }]}
            numberOfLines={1}
          >
            {upload.title}
          </Text>
          <Text style={[styles.rowSubtitle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {/* An empty artist is a valid private file, not a broken one. */}
            {upload.artistName || t('uploads.unknownArtist')}
            {upload.duration > 0 ? ` • ${formatDuration(upload.duration)}` : ''}
          </Text>
          {/* Retention, shown in the app rather than left to a notification the
              owner may never open. Playing the file pushes the date back. */}
          {expiringInDays !== null ? (
            <Text style={[styles.rowExpiry, { color: theme.colors.error }]} numberOfLines={1}>
              {expiringInDays === 0
                ? t('uploads.locker.expiringToday')
                : t('uploads.locker.expiringIn', { count: expiringInDays })}
            </Text>
          ) : null}
        </View>

        {upload.status === 'processing' && (
          <ActivityIndicator size="small" color={theme.colors.textSecondary} />
        )}
        {upload.status === 'failed' && (
          <Ionicons name="alert-circle-outline" size={18} color={theme.colors.error} />
        )}
      </Pressable>

      <Pressable
        onPress={() => setIsExpanded((expanded) => !expanded)}
        style={styles.iconButton}
        accessibilityRole="button"
        accessibilityLabel={t('uploads.locker.actions')}
      >
        <Ionicons
          name={isExpanded ? 'chevron-up' : 'ellipsis-horizontal'}
          size={18}
          color={theme.colors.textSecondary}
        />
      </Pressable>

      {isExpanded && (
        <View style={styles.actions}>
          <Text style={[styles.actionsHint, { color: theme.colors.textSecondary }]}>
            {t('uploads.locker.editHint')}
          </Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder={t('uploads.details.title')}
            placeholderTextColor={theme.colors.textSecondary}
            style={[styles.input, { backgroundColor: theme.colors.backgroundSecondary, color: theme.colors.text }]}
          />
          <TextInput
            value={artistName}
            onChangeText={setArtistName}
            placeholder={t('uploads.details.artist')}
            placeholderTextColor={theme.colors.textSecondary}
            style={[styles.input, { backgroundColor: theme.colors.backgroundSecondary, color: theme.colors.text }]}
          />
          <TextInput
            value={albumName}
            onChangeText={setAlbumName}
            placeholder={t('uploads.details.album')}
            placeholderTextColor={theme.colors.textSecondary}
            style={[styles.input, { backgroundColor: theme.colors.backgroundSecondary, color: theme.colors.text }]}
          />

          <Pressable
            onPress={() => void handleSave()}
            disabled={!hasEdits || updateUpload.isPending}
            style={[
              styles.actionButton,
              {
                backgroundColor:
                  hasEdits && !updateUpload.isPending
                    ? theme.colors.primary
                    : theme.colors.backgroundSecondary,
              },
            ]}
            accessibilityRole="button"
          >
            <Text
              style={[
                styles.actionButtonText,
                {
                  color:
                    hasEdits && !updateUpload.isPending
                      ? theme.colors.primaryForeground
                      : theme.colors.textSecondary,
                },
              ]}
            >
              {t('uploads.locker.save')}
            </Text>
          </Pressable>

          <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

          <Text style={[styles.actionsHint, { color: theme.colors.textSecondary }]}>
            {t('uploads.locker.contributeHint')}
          </Text>
          <Pressable
            onPress={() => setAttestationAccepted((accepted) => !accepted)}
            style={styles.attestationRow}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: attestationAccepted }}
          >
            <Ionicons
              name={attestationAccepted ? 'checkbox' : 'square-outline'}
              size={20}
              color={attestationAccepted ? theme.colors.primary : theme.colors.textSecondary}
            />
            <Text style={[styles.attestationText, { color: theme.colors.textSecondary }]}>
              {attestationStatement}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void handlePromote()}
            disabled={!attestationAccepted || !isPlayable || promoteUpload.isPending}
            style={[
              styles.actionButton,
              {
                backgroundColor:
                  attestationAccepted && isPlayable && !promoteUpload.isPending
                    ? theme.colors.primary
                    : theme.colors.backgroundSecondary,
              },
            ]}
            accessibilityRole="button"
          >
            <Text
              style={[
                styles.actionButtonText,
                {
                  color:
                    attestationAccepted && isPlayable && !promoteUpload.isPending
                      ? theme.colors.primaryForeground
                      : theme.colors.textSecondary,
                },
              ]}
            >
              {t('uploads.locker.contribute')}
            </Text>
          </Pressable>

          <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

          <Pressable
            onPress={() => void handleDelete()}
            disabled={deleteUpload.isPending}
            style={[styles.actionButton, { backgroundColor: theme.colors.backgroundSecondary }]}
            accessibilityRole="button"
          >
            <Text style={[styles.actionButtonText, { color: theme.colors.error }]}>
              {t('uploads.locker.delete')}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
};

const UploadsScreen: React.FC = () => {
  const theme = useTheme();
  const router = useRouter();
  const { t } = useTranslation();
  const gate = useAuthGate();
  const { uploads, isLoading, isError, refetch } = useUploads();
  const { albums: lockerAlbums } = useUploadAlbums();
  const playTrackList = usePlayerStore((state) => state.playTrackList);
  const currentTrack = usePlayerStore((state) => state.currentTrack);

  const albums = useMemo(() => resolveAlbums(lockerAlbums, uploads), [lockerAlbums, uploads]);
  const singles = useMemo(() => looseUploads(uploads), [uploads]);

  // Only a ready file has an HLS ladder to resolve; a processing one would fail
  // at the resolver, so it is not part of any play context.
  const playableUploads = useMemo(
    () => uploads.filter((upload) => upload.status === 'ready'),
    [uploads],
  );

  const playFrom = useCallback(
    (upload: UserUploadAsTrack) => {
      const index = playableUploads.findIndex((item) => item.id === upload.id);
      if (index < 0) {
        return;
      }
      void playTrackList(playableUploads, index, {
        type: 'library',
        id: 'uploads',
        name: t('uploads.locker.title'),
      });
    },
    [playTrackList, playableUploads, t],
  );

  // A locker id and a catalog id are ids in different collections, so the
  // comparison has to include the kind or an unlucky collision would highlight
  // the wrong row.
  const isCurrent = useCallback(
    (upload: UserUploadAsTrack) =>
      currentTrack?.kind === 'upload' && currentTrack.id === upload.id,
    [currentTrack],
  );

  if (gate.isTimedOut) {
    return (
      <EmptyState
        icon={{ name: 'cloud-offline-outline' }}
        error={{
          title: t('common.sessionUnavailable'),
          message: t('uploads.errors.session'),
          onRetry: async () => {
            gate.retry();
          },
        }}
      />
    );
  }

  if (gate.isResolving || (isLoading && gate.canUsePrivateApi)) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <LibraryListSkeleton count={8} />
      </View>
    );
  }

  if (!gate.canUsePrivateApi) {
    return (
      <EmptyState
        icon={{ name: 'lock-closed-outline' }}
        title={t('uploads.signedOut')}
        subtitle={t('uploads.signedOutHint')}
      />
    );
  }

  if (isError) {
    return (
      <EmptyState
        icon={{ name: 'cloud-offline-outline' }}
        error={{
          title: t('uploads.locker.loadError'),
          message: t('uploads.errors.upload'),
          onRetry: async () => {
            await refetch();
          },
        }}
      />
    );
  }

  return (
    <>
      <SEO title={t('uploads.locker.seo.title')} description={t('uploads.locker.seo.description')} />
      <ScrollView
        style={[styles.scroll, { backgroundColor: theme.colors.backgroundSecondary }]}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[styles.title, { color: theme.colors.text }]}>{t('uploads.locker.title')}</Text>
            <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
              {t('uploads.locker.subtitle')}
            </Text>
          </View>
          <Pressable
            onPress={() => router.push('/upload')}
            style={[styles.uploadButton, { backgroundColor: theme.colors.primary }]}
            accessibilityRole="button"
          >
            <Ionicons name="cloud-upload-outline" size={16} color={theme.colors.primaryForeground} />
            <Text style={[styles.uploadButtonText, { color: theme.colors.primaryForeground }]}>
              {t('uploads.title')}
            </Text>
          </Pressable>
        </View>

        {uploads.length === 0 ? (
          <EmptyState
            containerStyle={styles.inlineState}
            icon={{ name: 'cloud-upload-outline' }}
            title={t('uploads.locker.empty')}
            subtitle={t('uploads.locker.emptyHint')}
            action={{ label: t('uploads.title'), onPress: () => router.push('/upload') }}
          />
        ) : (
          <>
            {albums.map(({ album, tracks: albumTracks }) => (
              <View key={album.albumKey} style={styles.section}>
                <Text style={[styles.sectionTitle, { color: theme.colors.text }]} numberOfLines={1}>
                  {album.albumName ?? t('uploads.locker.untitledAlbum')}
                </Text>
                <Text style={[styles.sectionSubtitle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                  {/* The ALBUM artist, not a track's: on a compilation the track
                      artist differs per row, so a header taken from one would
                      name whichever track happened to sort first. */}
                  {album.albumArtistName || t('uploads.unknownArtist')}
                  {album.year ? ` • ${album.year}` : ''}
                  {` • ${t('uploads.locker.trackCount', { count: album.trackCount })}`}
                </Text>
                {albumTracks.map((upload) => (
                  <UploadRow
                    key={upload.id}
                    upload={upload}
                    isCurrent={isCurrent(upload)}
                    onPlay={() => playFrom(upload)}
                  />
                ))}
              </View>
            ))}

            {singles.length > 0 && (
              <View style={styles.section}>
                {albums.length > 0 && (
                  <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                    {t('uploads.locker.otherFiles')}
                  </Text>
                )}
                {singles.map((upload) => (
                  <UploadRow
                    key={upload.id}
                    upload={upload}
                    isCurrent={isCurrent(upload)}
                    onPlay={() => playFrom(upload)}
                  />
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </>
  );
};

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  centered: {
    flex: 1,
    padding: 16,
  },
  content: {
    padding: 16,
    paddingBottom: 120,
    gap: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  headerText: {
    flex: 1,
  },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 20,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  uploadButtonText: {
    fontSize: 13,
    fontWeight: '700',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 8,
  },
  inlineState: {
    flex: 0,
    paddingVertical: 32,
    backgroundColor: 'transparent',
  },
  section: {
    gap: 6,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  sectionSubtitle: {
    fontSize: 12,
    marginBottom: 2,
  },
  row: {
    borderRadius: 10,
    padding: 8,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  rowMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  artwork: {
    width: 44,
    height: 44,
    borderRadius: 4,
  },
  artworkPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  rowSubtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  rowExpiry: {
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
  },
  iconButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  actions: {
    width: '100%',
    gap: 8,
    paddingTop: 8,
  },
  actionsHint: {
    fontSize: 12,
    lineHeight: 16,
  },
  input: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  actionButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 20,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  actionButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 2,
  },
  attestationRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  attestationText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
  },
});

export default UploadsScreen;
