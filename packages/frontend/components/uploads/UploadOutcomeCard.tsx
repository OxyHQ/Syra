import React from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import type {
  UploadBlockedReason,
  UploadOutcome,
  UserUploadAsTrack,
} from '@syra/shared-types';
import { musicService } from '@/services/musicService';
import { useLibrary, useToggleLikeTrack } from '@/hooks/useLibrary';
import { useAuthGate } from '@/hooks/useAuthGate';
import { pickCatalogImageUrl } from '@/utils/pickImage';

/**
 * What happened to one uploaded file, said plainly.
 *
 * Five outcomes, five distinct renderings — deliberately NOT collapsed into a
 * success/error toast. Each one means something different to the person who
 * pressed upload, and three of them are not failures at all:
 *
 *  - `matched`   is the BEST result. The recording was already in the catalogue,
 *                so no bytes were transferred; saying so is the point, because
 *                "we didn't upload your file" reads as an error unless the
 *                reason is stated.
 *  - `duplicate` the file is already in their locker. Nothing to do.
 *  - `stored` / `published` the resulting item, with its ingest status.
 *  - `blocked`   a refusal that has to be explained by its `code`, not by a
 *                sentence the client cannot reason about — most of all
 *                `artist_unresolved`, where the actionable fact is that the FILE
 *                HAS NO ARTIST TAG, not that Syra said no.
 */

/**
 * One explanation per refusal code.
 *
 * A `Record` over the enum rather than a `switch` with a default: adding a code
 * to the contract makes this a compile error until it is explained, which is the
 * entire reason the backend types it as an enum instead of a string.
 */
const BLOCKED_REASON_KEYS: Record<UploadBlockedReason, string> = {
  artist_unresolved: 'uploads.blocked.artist_unresolved',
  artist_not_found: 'uploads.blocked.artist_not_found',
  artist_name_denylisted: 'uploads.blocked.artist_name_denylisted',
  artist_contributions_closed: 'uploads.blocked.artist_contributions_closed',
  artist_uploads_disabled: 'uploads.blocked.artist_uploads_disabled',
  // Says "you are barred", not "this profile is closed" — the contract keeps the
  // two codes apart precisely because they read as opposite things, and only
  // this one is worth offering an appeal for.
  contributor_blocked: 'uploads.blocked.contributor_blocked',
  attestation_required: 'uploads.blocked.attestation_required',
  commercial_provenance: 'uploads.blocked.commercial_provenance',
};

interface UploadOutcomeCardProps {
  /** The file name the listener picked, so a card is identifiable in a batch. */
  fileName: string;
  outcome: UploadOutcome;
  /**
   * The live locker item for a `stored` outcome, when the polling list has a
   * fresher copy than the upload response did. Absent means "use the response".
   */
  liveUpload?: UserUploadAsTrack;
  /** Retry this file privately. Offered only where the locker is a real answer. */
  onKeepPrivate?: () => void;
  /** Whether {@link onKeepPrivate} is currently running. */
  isKeepingPrivate?: boolean;
}

/**
 * The catalogue track an outcome points at.
 *
 * Both outcomes that name a `trackId` — `matched` and `published` — carry only
 * the id, so the track itself is fetched here; showing "this is already on Syra"
 * without showing WHICH recording would be an assertion the listener cannot
 * check. The link goes to the artist's page because Syra has no per-track
 * screen, and for a contribution the artist page is where it now appears.
 *
 * `showAddToLibrary` is what separates the two: only a `matched` file leaves the
 * listener with something to do.
 */
const CatalogTrackPreview: React.FC<{ trackId: string; showAddToLibrary: boolean }> = ({
  trackId,
  showAddToLibrary,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const gate = useAuthGate();
  const { isTrackLiked } = useLibrary();
  const toggleLike = useToggleLikeTrack();

  const trackQuery = useQuery({
    queryKey: ['track', trackId, gate.catalogIdentity],
    queryFn: () => musicService.getTrackById(trackId),
    enabled: gate.isResolved,
  });

  const track = trackQuery.data;
  const isLiked = isTrackLiked(trackId);

  /**
   * The library control, which survives a failed catalog read.
   *
   * The row above it is a nicety; THIS is the actionable payload of a `matched`
   * result. Rendering nothing when the track lookup fails would turn the best
   * outcome — "you already have this, here it is" — into a dead end, so the
   * action is built from the id alone. `track` is optional to the mutation; it
   * only seeds the optimistic cache entry.
   */
  const addAction = showAddToLibrary ? (
    <Pressable
      onPress={() => toggleLike.mutate({ id: trackId, next: !isLiked, track })}
      style={[
        styles.inlineAction,
        { backgroundColor: isLiked ? theme.colors.backgroundSecondary : theme.colors.primary },
      ]}
      accessibilityRole="button"
      disabled={toggleLike.isPending}
    >
      <Ionicons
        name={isLiked ? 'checkmark' : 'add'}
        size={16}
        color={isLiked ? theme.colors.text : theme.colors.primaryForeground}
      />
      <Text
        style={[
          styles.inlineActionText,
          { color: isLiked ? theme.colors.text : theme.colors.primaryForeground },
        ]}
      >
        {isLiked ? t('uploads.matched.added') : t('uploads.matched.addToLibrary')}
      </Text>
    </Pressable>
  ) : null;

  if (!track) {
    if (trackQuery.isLoading) {
      return <ActivityIndicator size="small" color={theme.colors.primary} />;
    }
    return addAction ? <View style={styles.matchedTrack}>{addAction}</View> : null;
  }

  const artworkUrl = pickCatalogImageUrl(track.images, track.coverArt, 'thumbnail', track.coverArtSizes);

  return (
    <View style={styles.matchedTrack}>
      <Pressable
        style={styles.matchedTrackInfo}
        accessibilityRole="button"
        onPress={() => router.push({ pathname: '/p/[id]', params: { id: track.artistId } })}
        disabled={!track.artistId}
      >
        {artworkUrl ? (
          <Image source={{ uri: artworkUrl }} style={styles.matchedArtwork} contentFit="cover" />
        ) : (
          <View style={[styles.matchedArtwork, { backgroundColor: theme.colors.backgroundTertiary }]}>
            <Ionicons name="musical-note" size={18} color={theme.colors.textSecondary} />
          </View>
        )}
        <View style={styles.matchedText}>
          <Text style={[styles.matchedTitle, { color: theme.colors.text }]} numberOfLines={1}>
            {track.title}
          </Text>
          <Text style={[styles.matchedArtist, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {track.artistName}
          </Text>
        </View>
      </Pressable>

      {addAction}
    </View>
  );
};

export const UploadOutcomeCard: React.FC<UploadOutcomeCardProps> = ({
  fileName,
  outcome,
  liveUpload,
  onKeepPrivate,
  isKeepingPrivate = false,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const router = useRouter();

  // Tone, not verdict: `matched` and `duplicate` are neither successes nor
  // failures — nothing was stored and nothing went wrong — so they read as
  // information rather than borrowing either colour.
  const accent =
    outcome.outcome === 'blocked'
      ? theme.colors.error
      : outcome.outcome === 'stored' || outcome.outcome === 'published'
        ? theme.colors.primary
        : theme.colors.textSecondary;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.colors.backgroundTertiary, borderColor: accent },
      ]}
    >
      <Text style={[styles.fileName, { color: theme.colors.textSecondary }]} numberOfLines={1}>
        {fileName}
      </Text>

      {outcome.outcome === 'matched' && (
        <>
          <Text style={[styles.outcomeTitle, { color: theme.colors.text }]}>
            {t('uploads.matched.title')}
          </Text>
          <Text style={[styles.outcomeBody, { color: theme.colors.textSecondary }]}>
            {t('uploads.matched.body')}
          </Text>
          <CatalogTrackPreview trackId={outcome.trackId} showAddToLibrary />
        </>
      )}

      {outcome.outcome === 'duplicate' && (
        <>
          <Text style={[styles.outcomeTitle, { color: theme.colors.text }]}>
            {t('uploads.duplicate.title')}
          </Text>
          <Text style={[styles.outcomeBody, { color: theme.colors.textSecondary }]}>
            {t('uploads.duplicate.body')}
          </Text>
          <Pressable
            onPress={() => router.push('/library/uploads')}
            style={[styles.inlineAction, { backgroundColor: theme.colors.backgroundSecondary }]}
            accessibilityRole="button"
          >
            <Ionicons name="folder-open-outline" size={16} color={theme.colors.text} />
            <Text style={[styles.inlineActionText, { color: theme.colors.text }]}>
              {t('uploads.openLocker')}
            </Text>
          </Pressable>
        </>
      )}

      {outcome.outcome === 'stored' && (
        <StoredOutcome upload={liveUpload ?? outcome.upload} />
      )}

      {outcome.outcome === 'published' && (
        <>
          <Text style={[styles.outcomeTitle, { color: theme.colors.text }]}>
            {t('uploads.published.title')}
          </Text>
          <Text style={[styles.outcomeBody, { color: theme.colors.textSecondary }]}>
            {t('uploads.published.body')}
          </Text>
          <CatalogTrackPreview trackId={outcome.trackId} showAddToLibrary={false} />
        </>
      )}

      {outcome.outcome === 'blocked' && (
        <>
          <Text style={[styles.outcomeTitle, { color: theme.colors.error }]}>
            {t('uploads.blocked.title')}
          </Text>
          {/* The code's own explanation first — it says what the FILE is
              missing. The server's sentence follows as supporting detail. */}
          <Text style={[styles.outcomeBody, { color: theme.colors.text }]}>
            {t(BLOCKED_REASON_KEYS[outcome.code])}
          </Text>
          <Text style={[styles.outcomeDetail, { color: theme.colors.textSecondary }]}>
            {outcome.message}
          </Text>

          {outcome.markers.length > 0 && (
            <View style={styles.markers}>
              <Text style={[styles.markersTitle, { color: theme.colors.textSecondary }]}>
                {t('uploads.blocked.evidence')}
              </Text>
              {outcome.markers.map((marker) => (
                <Text
                  key={`${marker.code}-${marker.detail ?? ''}`}
                  style={[styles.markerRow, { color: theme.colors.textSecondary }]}
                >
                  {marker.detail ? `${marker.code} — ${marker.detail}` : marker.code}
                </Text>
              ))}
            </View>
          )}

          {onKeepPrivate && (
            <Pressable
              onPress={onKeepPrivate}
              disabled={isKeepingPrivate}
              style={[styles.inlineAction, { backgroundColor: theme.colors.backgroundSecondary }]}
              accessibilityRole="button"
            >
              {isKeepingPrivate ? (
                <ActivityIndicator size="small" color={theme.colors.text} />
              ) : (
                <Ionicons name="lock-closed-outline" size={16} color={theme.colors.text} />
              )}
              <Text style={[styles.inlineActionText, { color: theme.colors.text }]}>
                {t('uploads.blocked.keepPrivate')}
              </Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
};

/** A file kept in the locker, with whatever ingest has made of it so far. */
const StoredOutcome: React.FC<{ upload: UserUploadAsTrack }> = ({ upload }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const router = useRouter();

  const statusKey =
    upload.status === 'ready'
      ? 'uploads.stored.ready'
      : upload.status === 'failed'
        ? 'uploads.stored.failed'
        : 'uploads.stored.processing';

  return (
    <>
      <Text style={[styles.outcomeTitle, { color: theme.colors.text }]}>
        {t('uploads.stored.title')}
      </Text>
      <Text style={[styles.outcomeBody, { color: theme.colors.textSecondary }]}>
        {/* An upload with no artist is a VALID private file, never an error:
            a locker exists for exactly the material nobody catalogued. */}
        {upload.title}
        {' — '}
        {upload.artistName || t('uploads.unknownArtist')}
      </Text>
      <View style={styles.statusRow}>
        {upload.status === 'processing' && (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        )}
        <Text
          style={[
            styles.outcomeDetail,
            { color: upload.status === 'failed' ? theme.colors.error : theme.colors.textSecondary },
          ]}
        >
          {t(statusKey)}
        </Text>
      </View>
      <Pressable
        onPress={() => router.push('/library/uploads')}
        style={[styles.inlineAction, { backgroundColor: theme.colors.backgroundSecondary }]}
        accessibilityRole="button"
      >
        <Ionicons name="folder-open-outline" size={16} color={theme.colors.text} />
        <Text style={[styles.inlineActionText, { color: theme.colors.text }]}>
          {t('uploads.openLocker')}
        </Text>
      </Pressable>
    </>
  );
};

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderLeftWidth: 3,
    padding: 12,
    gap: 6,
  },
  fileName: {
    fontSize: 11,
    fontWeight: '500',
  },
  outcomeTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  outcomeBody: {
    fontSize: 13,
    lineHeight: 18,
  },
  outcomeDetail: {
    fontSize: 12,
    lineHeight: 16,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  markers: {
    gap: 2,
    marginTop: 4,
  },
  markersTitle: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  markerRow: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  inlineAction: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    marginTop: 4,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  inlineActionText: {
    fontSize: 13,
    fontWeight: '600',
  },
  matchedTrack: {
    gap: 8,
    marginTop: 4,
  },
  matchedTrackInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  matchedArtwork: {
    width: 40,
    height: 40,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  matchedText: {
    flex: 1,
  },
  matchedTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  matchedArtist: {
    fontSize: 12,
  },
});
