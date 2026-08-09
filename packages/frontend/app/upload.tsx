import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { toast } from '@oxyhq/bloom/toast';
import type { UploadDestination, UploadOutcome } from '@syra/shared-types';
import SEO from '@/components/SEO';
import { EmptyState } from '@/components/common/EmptyState';
import { CoverArtPicker } from '@/components/playlists/CoverArtPicker';
import { UploadOutcomeCard } from '@/components/uploads/UploadOutcomeCard';
import { useAuthGate } from '@/hooks/useAuthGate';
import { useCreateUpload, useUploads } from '@/hooks/useUploads';
import type { UploadAudioFile } from '@/services/uploadsService';
import { createScopedLogger } from '@/utils/logger';

/**
 * Upload music (`/upload`).
 *
 * The shape of this screen is dictated by one fact about the API: there is no
 * extract-only endpoint. `POST /uploads` reads the file's tags, dedups, screens
 * and routes in a single request, so the metadata the listener reviews only
 * exists AFTER the file has been sent. Hence two review points rather than one:
 *
 *  - BEFORE sending, optional overrides for what the listener already knows the
 *    file gets wrong, plus the destination and — for the public path — the
 *    rights declaration, which the backend requires up front because it is the
 *    evidence the contribution is recorded against.
 *  - AFTER sending, the outcome card, where a stored file's extracted metadata
 *    is shown and can be corrected in the locker.
 *
 * Files are uploaded one at a time on purpose: a batch of 200MB files in flight
 * together is the shape that exhausts a phone's memory and a hotel's uplink, and
 * sequential uploads let each outcome appear as soon as it is known.
 */

const logger = createScopedLogger('UploadScreen');

/** Cap on one batch, so a stray "select all" cannot queue a thousand files. */
const MAX_FILES_PER_BATCH = 25;

interface PickedFile {
  /** Stable local key: a name can repeat across directories in one pick. */
  key: string;
  audioFile: UploadAudioFile;
  destination: UploadDestination;
  title: string;
  artistName: string;
  albumName: string;
  /**
   * The recording's ISRC, typed by the uploader.
   *
   * Not an override like the fields above it: the catalogue REQUIRES an
   * identifier, and the two tiers that try to find one without asking — the
   * file's own tag and an acoustic match — both come up empty for plenty of
   * legitimate releases. Only offered on the public path, because the locker
   * asks for no identifier at all and a field that changes nothing is worse
   * than no field.
   */
  isrc: string;
  coverArt: string | null;
  /** Whether the per-file override fields are expanded. */
  showDetails: boolean;
}

function formatBytes(size: number | undefined): string {
  if (!size || size <= 0) {
    return '';
  }
  const megabytes = size / (1024 * 1024);
  return megabytes >= 1 ? `${megabytes.toFixed(1)} MB` : `${Math.round(size / 1024)} KB`;
}

const UploadScreen: React.FC = () => {
  const theme = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const gate = useAuthGate();
  const createUpload = useCreateUpload();
  // The locker list polls itself while anything is transcoding, so a stored
  // outcome card can read live status from it instead of owning a second poller.
  const { uploads } = useUploads();

  const [files, setFiles] = useState<PickedFile[]>([]);
  const [attestationAccepted, setAttestationAccepted] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, UploadOutcome>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  /** A blocked public file being retried privately, by key. */
  const [keepingPrivateKey, setKeepingPrivateKey] = useState<string | null>(null);

  const attestationStatement = t('uploads.attestation.statement');

  const hasPublicFile = files.some((file) => file.destination === 'public');
  const pendingFiles = files.filter((file) => !outcomes[file.key]);
  const isUploading = uploadingKey !== null;
  // The backend refuses a public upload without a signed statement; refusing to
  // start here means the listener finds out before the bytes move, not after.
  const attestationMissing = hasPublicFile && !attestationAccepted;
  const canUpload = pendingFiles.length > 0 && !isUploading && !attestationMissing;

  /** Live locker copies of stored outcomes, so a card's status stays current. */
  const uploadsById = useMemo(
    () => new Map(uploads.map((upload) => [upload.id, upload])),
    [uploads],
  );

  const handlePick = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (result.canceled) {
        return;
      }

      const picked: PickedFile[] = result.assets.map((asset, index) => ({
        key: `${Date.now()}-${index}-${asset.name}`,
        audioFile: {
          uri: asset.uri,
          name: asset.name,
          mimeType: asset.mimeType ?? 'audio/mpeg',
          size: asset.size ?? undefined,
          file: asset.file,
        },
        destination: 'private',
        title: '',
        artistName: '',
        albumName: '',
        isrc: '',
        coverArt: null,
        showDetails: false,
      }));

      setFiles((current) => [...current, ...picked].slice(0, MAX_FILES_PER_BATCH));
    } catch (error) {
      logger.error('Failed to pick audio files', error);
      toast.error(t('uploads.errors.picker'));
    }
  }, [t]);

  const updateFile = useCallback((key: string, patch: Partial<PickedFile>) => {
    setFiles((current) => current.map((file) => (file.key === key ? { ...file, ...patch } : file)));
  }, []);

  const removeFile = useCallback((key: string) => {
    setFiles((current) => current.filter((file) => file.key !== key));
    setOutcomes((current) => {
      const { [key]: _removed, ...rest } = current;
      return rest;
    });
    setFailures((current) => {
      const { [key]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  /**
   * Send one file and record what came back — including a refusal.
   *
   * Returns the outcome as well as storing it. A batch cannot count its own
   * results from `outcomes` afterwards: `setOutcomes` does not apply inside the
   * loop that produced it, so a summary read from state would describe the
   * batch before this one.
   */
  const uploadOne = useCallback(
    async (file: PickedFile, destination: UploadDestination): Promise<UploadOutcome> => {
      const outcome = await createUpload.mutateAsync({
        audioFile: file.audioFile,
        request: {
          destination,
          title: file.title,
          artistName: file.artistName,
          albumName: file.albumName,
          // Only the public path has anything to do with it, and `destination`
          // is the argument rather than `file.destination` because this is also
          // the retry that sends a refused public file to the locker.
          isrc: destination === 'public' ? file.isrc : undefined,
          coverArt: file.coverArt ?? undefined,
          // Sent verbatim as it was displayed: an attestation is evidence that
          // this person agreed to THIS text, so storing a different string —
          // or one in a language they were never shown — would prove nothing.
          attestation: destination === 'public' ? attestationStatement : undefined,
        },
      });
      setOutcomes((current) => ({ ...current, [file.key]: outcome }));
      setFailures((current) => {
        const { [file.key]: _cleared, ...rest } = current;
        return rest;
      });
      return outcome;
    },
    [attestationStatement, createUpload],
  );

  /**
   * Upload the queue, then say how the BATCH went — and only that.
   *
   * The one fact no outcome card can carry: a card is a per-file end state, and
   * "the run you started is finished, here is how much of it needs you" is a
   * property of the run. Files are sent one at a time, so a batch of twenty is
   * minutes of watching a list to find out it stopped.
   *
   * Everything the toast does NOT say is deliberate. It never restates a
   * refusal, because a refusal is a `code` with an actionable explanation
   * attached — `isrc_mismatch` names which of the length, title or artist
   * disagreed — and none of that survives a sentence in a toast. It counts, and
   * points at the cards, which persist and name the file.
   *
   * Skipped entirely for a single file: its card appears in place, and a toast
   * saying "1 file finished" beside a card saying what happened to it is the
   * duplication this whole surface is supposed to avoid.
   */
  const handleUploadAll = useCallback(async () => {
    const batch = pendingFiles;
    let refused = 0;
    let failed = 0;
    /**
     * Captured HERE, not read back from `failures`.
     *
     * `setFailures` is a state update: the `failures` this callback closes over
     * is the value from the render that created it, so reading it after the loop
     * yields the PREVIOUS run's message, or nothing on a first failure. A local
     * is the only thing that sees what this run just produced.
     */
    let firstFailureMessage = '';

    for (const file of batch) {
      setUploadingKey(file.key);
      try {
        const outcome = await uploadOne(file, file.destination);
        if (outcome.outcome === 'blocked') {
          refused += 1;
        }
      } catch (error) {
        logger.error('Upload failed', { fileName: file.audioFile.name, error });
        failed += 1;
        if (!firstFailureMessage && error instanceof Error && error.message.trim()) {
          firstFailureMessage = error.message;
        }
        setFailures((current) => ({
          ...current,
          [file.key]: error instanceof Error ? error.message : t('uploads.errors.upload'),
        }));
      }
    }
    setUploadingKey(null);

    /**
     * A single file gets a toast too.
     *
     * The card is the detailed answer and stays on screen, but it renders
     * inline in a list the reader may have scrolled past — so on its own it
     * left "did that work?" answerable only by hunting for the card, or by
     * opening the console. The toast is the acknowledgement; the card remains
     * the explanation, and the toast never restates a refusal's `code` because
     * that is exactly what the card is for.
     */
    if (batch.length === 1) {
      /**
       * A FAILURE carries its reason into the toast; a refusal still does not.
       *
       * The distinction is not cosmetic. A refusal's card is a structured
       * `outcome` with a `code` and an actionable explanation, and a sentence
       * cannot carry it — that is what the card is for. A failure is a thrown
       * error, and its message is frequently the only actionable thing in the
       * run: `USUG12606557 belongs to a different recording — … Check the code,
       * or keep the file in your private library instead.` names the identifier,
       * the conflict and the two ways out.
       *
       * Reported after a real upload where that sentence existed only in the
       * console: the card renders it, but inline in a list, and the uploader
       * read the browser console before they read the card.
       */
      if (failed > 0) {
        toast.error(firstFailureMessage || t('uploads.toasts.oneFailed'));
      } else if (refused > 0) toast.info(t('uploads.toasts.oneRefused'));
      else toast.success(t('uploads.toasts.oneDone'));
      return;
    }
    if (batch.length < 2) {
      return;
    }
    const needsAttention = refused + failed;
    if (needsAttention === 0) {
      // `total`, not `count`: passing `count` puts i18next into plural
      // resolution, and this string has no plural forms because it is only ever
      // shown for two files or more.
      toast.success(t('uploads.toasts.batchDone', { total: batch.length }));
      return;
    }
    // Same sentence, two levels: a refusal is a decision about a file and a
    // transport failure is something that broke, and only the second is an
    // error. The words stay identical because the CARDS are where the
    // difference is explained, and a toast that tried to would be guessing
    // which of the two the reader cares about.
    const summary = t('uploads.toasts.batchNeedsAttention', {
      count: needsAttention,
      total: batch.length,
    });
    if (failed > 0) {
      toast.error(summary);
    } else {
      toast.info(summary);
    }
  }, [pendingFiles, t, uploadOne]);

  /**
   * Retry a refused public contribution as a private file.
   *
   * Offered rather than done automatically: the public path REFUSES instead of
   * silently downgrading precisely so the listener's stated intent is never
   * quietly changed. Choosing the locker has to be their decision.
   *
   * A failure here is the ONE event on this screen with nowhere to appear, and a
   * toast is the whole of the fix. The inline failure line renders only while a
   * file has no outcome (`failure && !outcome`), and this retry is offered only
   * from a `blocked` card — so the file always has one. Writing to `failures`
   * from here therefore stored a message nothing could ever render: the spinner
   * stopped, the card stayed as it was, and the listener was told nothing at
   * all. Success needs no toast, because the card itself changes from the
   * refusal to the stored file.
   */
  const handleKeepPrivate = useCallback(
    async (file: PickedFile) => {
      setKeepingPrivateKey(file.key);
      try {
        await uploadOne(file, 'private');
      } catch (error) {
        logger.error('Private retry failed', { fileName: file.audioFile.name, error });
        toast.error(error instanceof Error ? error.message : t('uploads.errors.keepPrivate'));
      } finally {
        setKeepingPrivateKey(null);
      }
    },
    [t, uploadOne],
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

  if (gate.isResolving) {
    return (
      <View className="bg-surface" style={styles.centered}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
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

  return (
    <>
      <SEO title={t('uploads.seo.title')} description={t('uploads.seo.description')} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          className="bg-surface" style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: 120 + insets.bottom }]}
          showsVerticalScrollIndicator={false}
        >
          <Text className="text-foreground" style={styles.title}>{t('uploads.title')}</Text>
          <Text className="text-muted-foreground" style={styles.subtitle}>
            {t('uploads.subtitle')}
          </Text>

          <Pressable
            onPress={handlePick}
            disabled={isUploading}
            className="border-border" style={styles.pickButton}
            accessibilityRole="button"
          >
            <Ionicons name="cloud-upload-outline" size={22} color={theme.colors.text} />
            <Text className="text-foreground" style={styles.pickButtonText}>
              {files.length === 0 ? t('uploads.pick') : t('uploads.pickMore')}
            </Text>
          </Pressable>

          {files.length === 0 && (
            <Text className="text-muted-foreground" style={styles.hint}>
              {t('uploads.emptyHint')}
            </Text>
          )}

          {files.map((file) => {
            const outcome = outcomes[file.key];
            const failure = failures[file.key];
            const isThisUploading = uploadingKey === file.key;

            return (
              <View
                key={file.key}
                className="bg-popover" style={styles.fileCard}
              >
                <View style={styles.fileHeader}>
                  <View style={styles.fileHeaderText}>
                    <Text className="text-foreground" style={styles.fileName} numberOfLines={1}>
                      {file.audioFile.name}
                    </Text>
                    <Text className="text-muted-foreground" style={styles.fileMeta}>
                      {formatBytes(file.audioFile.size)}
                    </Text>
                  </View>
                  {!isThisUploading && (
                    <Pressable
                      onPress={() => removeFile(file.key)}
                      style={styles.iconButton}
                      accessibilityRole="button"
                      accessibilityLabel={t('uploads.remove')}
                    >
                      <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                    </Pressable>
                  )}
                </View>

                {!outcome && (
                  <>
                    <View style={styles.destinationRow}>
                      {(['private', 'public'] as const).map((destination) => {
                        const isActive = file.destination === destination;
                        return (
                          <Pressable
                            key={destination}
                            // Choosing the public path opens the details panel.
                            // The catalogue refuses a contribution with no
                            // artist — there is nobody to attribute the work to,
                            // and nobody to address a takedown at — but the
                            // artist field lives behind this collapsed panel, so
                            // the requirement was invisible until the whole file
                            // had uploaded and come back rejected. Surfacing it
                            // at the moment the choice is made costs nothing and
                            // turns a wasted upload into a filled-in field.
                            onPress={() =>
                              updateFile(file.key, {
                                destination,
                                showDetails: destination === 'public' ? true : file.showDetails,
                              })
                            }
                            disabled={isUploading}
                            style={[
                              styles.destinationChip,
                              {
                                backgroundColor: isActive
                                  ? theme.colors.primary
                                  : theme.colors.backgroundSecondary,
                              },
                            ]}
                            accessibilityRole="button"
                            accessibilityState={{ selected: isActive }}
                          >
                            <Ionicons
                              name={destination === 'private' ? 'lock-closed' : 'globe-outline'}
                              size={14}
                              color={isActive ? theme.colors.primaryForeground : theme.colors.text}
                            />
                            <Text
                              style={[
                                styles.destinationChipText,
                                {
                                  color: isActive
                                    ? theme.colors.primaryForeground
                                    : theme.colors.text,
                                },
                              ]}
                            >
                              {t(`uploads.destination.${destination}`)}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    <Text className="text-muted-foreground" style={styles.destinationHint}>
                      {t(`uploads.destination.${file.destination}Hint`)}
                    </Text>

                    <Pressable
                      onPress={() => updateFile(file.key, { showDetails: !file.showDetails })}
                      style={styles.detailsToggle}
                      accessibilityRole="button"
                    >
                      <Ionicons
                        name={file.showDetails ? 'chevron-down' : 'chevron-forward'}
                        size={16}
                        color={theme.colors.textSecondary}
                      />
                      <Text className="text-muted-foreground" style={styles.detailsToggleText}>
                        {t('uploads.details.toggle')}
                      </Text>
                    </Pressable>

                    {file.showDetails && (
                      <View style={styles.details}>
                        <Text className="text-muted-foreground" style={styles.detailsHint}>
                          {t('uploads.details.hint')}
                        </Text>
                        <TextInput className="bg-surface text-foreground"
                          value={file.title}
                          onChangeText={(title) => updateFile(file.key, { title })}
                          placeholder={t('uploads.details.title')}
                          placeholderTextColor={theme.colors.textSecondary}
                          editable={!isUploading}
                          style={[
                            styles.input,
                          ]}
                        />
                        <TextInput className="bg-surface text-foreground"
                          value={file.artistName}
                          onChangeText={(artistName) => updateFile(file.key, { artistName })}
                          placeholder={t('uploads.details.artist')}
                          placeholderTextColor={theme.colors.textSecondary}
                          editable={!isUploading}
                          style={[
                            styles.input,
                          ]}
                        />
                        <TextInput className="bg-surface text-foreground"
                          value={file.albumName}
                          onChangeText={(albumName) => updateFile(file.key, { albumName })}
                          placeholder={t('uploads.details.album')}
                          placeholderTextColor={theme.colors.textSecondary}
                          editable={!isUploading}
                          style={[
                            styles.input,
                          ]}
                        />
                        {file.destination === 'public' && (
                          <>
                            <TextInput className="bg-surface text-foreground"
                              value={file.isrc}
                              onChangeText={(isrc) => updateFile(file.key, { isrc })}
                              placeholder={t('uploads.details.isrc')}
                              placeholderTextColor={theme.colors.textSecondary}
                              editable={!isUploading}
                              autoCapitalize="characters"
                              autoCorrect={false}
                              style={[
                                styles.input,
                              ]}
                            />
                            <Text className="text-muted-foreground" style={styles.detailsHint}>
                              {t('uploads.details.isrcHint')}
                            </Text>
                          </>
                        )}
                        <CoverArtPicker
                          value={file.coverArt ?? undefined}
                          onChange={(coverArt) => updateFile(file.key, { coverArt })}
                          size={120}
                          disabled={isUploading}
                        />
                      </View>
                    )}
                  </>
                )}

                {isThisUploading && (
                  <View style={styles.statusRow}>
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                    <Text className="text-muted-foreground" style={styles.fileMeta}>
                      {t('uploads.uploading')}
                    </Text>
                  </View>
                )}

                {failure && !outcome && (
                  <Text className="text-error" style={styles.failureText}>{failure}</Text>
                )}

                {outcome && (
                  <UploadOutcomeCard
                    fileName={file.audioFile.name}
                    outcome={outcome}
                    liveUpload={
                      outcome.outcome === 'stored' ? uploadsById.get(outcome.upload.id) : undefined
                    }
                    onKeepPrivate={
                      outcome.outcome === 'blocked' ? () => void handleKeepPrivate(file) : undefined
                    }
                    isKeepingPrivate={keepingPrivateKey === file.key}
                  />
                )}
              </View>
            );
          })}

          {hasPublicFile && (
            <Pressable
              onPress={() => setAttestationAccepted((accepted) => !accepted)}
              disabled={isUploading}
              className="bg-popover" style={styles.attestation}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: attestationAccepted }}
            >
              <Ionicons
                name={attestationAccepted ? 'checkbox' : 'square-outline'}
                size={22}
                color={attestationAccepted ? theme.colors.primary : theme.colors.textSecondary}
              />
              <View style={styles.attestationText}>
                <Text className="text-foreground" style={styles.attestationTitle}>
                  {t('uploads.attestation.title')}
                </Text>
                <Text className="text-muted-foreground" style={styles.attestationBody}>
                  {attestationStatement}
                </Text>
              </View>
            </Pressable>
          )}

          {attestationMissing && (
            <Text className="text-error" style={styles.failureText}>
              {t('uploads.attestation.required')}
            </Text>
          )}
        </ScrollView>

        {pendingFiles.length > 0 && (
          <View
            className="bg-surface border-t-border"
            style={[styles.footer, { paddingBottom: 16 + insets.bottom }]}
          >
            <Pressable
              onPress={() => void handleUploadAll()}
              disabled={!canUpload}
              style={[
                styles.submitButton,
                { backgroundColor: canUpload ? theme.colors.primary : theme.colors.backgroundTertiary },
              ]}
              accessibilityRole="button"
            >
              {isUploading ? (
                <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
              ) : (
                <Text
                  style={[
                    styles.submitButtonText,
                    {
                      color: canUpload ? theme.colors.primaryForeground : theme.colors.textSecondary,
                    },
                  ]}
                >
                  {t('uploads.submit', { count: pendingFiles.length })}
                </Text>
              )}
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
    </>
  );
};

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 16,
    gap: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 4,
  },
  pickButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 18,
    borderRadius: 12,
    borderWidth: 2,
    borderStyle: 'dashed',
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  pickButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  hint: {
    fontSize: 12,
    textAlign: 'center',
  },
  fileCard: {
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  fileHeaderText: {
    flex: 1,
  },
  fileName: {
    fontSize: 14,
    fontWeight: '600',
  },
  fileMeta: {
    fontSize: 12,
  },
  iconButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  destinationRow: {
    flexDirection: 'row',
    gap: 8,
  },
  destinationChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  destinationChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  destinationHint: {
    fontSize: 12,
    lineHeight: 16,
  },
  detailsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingVertical: 4,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  detailsToggleText: {
    fontSize: 12,
    fontWeight: '600',
  },
  details: {
    gap: 8,
  },
  detailsHint: {
    fontSize: 12,
  },
  input: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  failureText: {
    fontSize: 12,
    lineHeight: 16,
  },
  attestation: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: 12,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  attestationText: {
    flex: 1,
    gap: 4,
  },
  attestationTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  attestationBody: {
    fontSize: 12,
    lineHeight: 17,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  submitButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 24,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  submitButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
});

export default UploadScreen;
