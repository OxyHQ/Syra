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

  /** Send one file and record what came back — including a refusal. */
  const uploadOne = useCallback(
    async (file: PickedFile, destination: UploadDestination): Promise<void> => {
      const outcome = await createUpload.mutateAsync({
        audioFile: file.audioFile,
        request: {
          destination,
          title: file.title,
          artistName: file.artistName,
          albumName: file.albumName,
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
    },
    [attestationStatement, createUpload],
  );

  const handleUploadAll = useCallback(async () => {
    for (const file of pendingFiles) {
      setUploadingKey(file.key);
      try {
        await uploadOne(file, file.destination);
      } catch (error) {
        logger.error('Upload failed', { fileName: file.audioFile.name, error });
        setFailures((current) => ({
          ...current,
          [file.key]: error instanceof Error ? error.message : t('uploads.errors.upload'),
        }));
      }
    }
    setUploadingKey(null);
  }, [pendingFiles, t, uploadOne]);

  /**
   * Retry a refused public contribution as a private file.
   *
   * Offered rather than done automatically: the public path REFUSES instead of
   * silently downgrading precisely so the listener's stated intent is never
   * quietly changed. Choosing the locker has to be their decision.
   */
  const handleKeepPrivate = useCallback(
    async (file: PickedFile) => {
      setKeepingPrivateKey(file.key);
      try {
        await uploadOne(file, 'private');
      } catch (error) {
        logger.error('Private retry failed', { fileName: file.audioFile.name, error });
        setFailures((current) => ({
          ...current,
          [file.key]: error instanceof Error ? error.message : t('uploads.errors.upload'),
        }));
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
      <View style={[styles.centered, { backgroundColor: theme.colors.backgroundSecondary }]}>
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
          style={[styles.scroll, { backgroundColor: theme.colors.backgroundSecondary }]}
          contentContainerStyle={[styles.content, { paddingBottom: 120 + insets.bottom }]}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.title, { color: theme.colors.text }]}>{t('uploads.title')}</Text>
          <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
            {t('uploads.subtitle')}
          </Text>

          <Pressable
            onPress={handlePick}
            disabled={isUploading}
            style={[styles.pickButton, { borderColor: theme.colors.border }]}
            accessibilityRole="button"
          >
            <Ionicons name="cloud-upload-outline" size={22} color={theme.colors.text} />
            <Text style={[styles.pickButtonText, { color: theme.colors.text }]}>
              {files.length === 0 ? t('uploads.pick') : t('uploads.pickMore')}
            </Text>
          </Pressable>

          {files.length === 0 && (
            <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
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
                style={[styles.fileCard, { backgroundColor: theme.colors.backgroundTertiary }]}
              >
                <View style={styles.fileHeader}>
                  <View style={styles.fileHeaderText}>
                    <Text style={[styles.fileName, { color: theme.colors.text }]} numberOfLines={1}>
                      {file.audioFile.name}
                    </Text>
                    <Text style={[styles.fileMeta, { color: theme.colors.textSecondary }]}>
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
                            onPress={() => updateFile(file.key, { destination })}
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
                    <Text style={[styles.destinationHint, { color: theme.colors.textSecondary }]}>
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
                      <Text style={[styles.detailsToggleText, { color: theme.colors.textSecondary }]}>
                        {t('uploads.details.toggle')}
                      </Text>
                    </Pressable>

                    {file.showDetails && (
                      <View style={styles.details}>
                        <Text style={[styles.detailsHint, { color: theme.colors.textSecondary }]}>
                          {t('uploads.details.hint')}
                        </Text>
                        <TextInput
                          value={file.title}
                          onChangeText={(title) => updateFile(file.key, { title })}
                          placeholder={t('uploads.details.title')}
                          placeholderTextColor={theme.colors.textSecondary}
                          editable={!isUploading}
                          style={[
                            styles.input,
                            { backgroundColor: theme.colors.backgroundSecondary, color: theme.colors.text },
                          ]}
                        />
                        <TextInput
                          value={file.artistName}
                          onChangeText={(artistName) => updateFile(file.key, { artistName })}
                          placeholder={t('uploads.details.artist')}
                          placeholderTextColor={theme.colors.textSecondary}
                          editable={!isUploading}
                          style={[
                            styles.input,
                            { backgroundColor: theme.colors.backgroundSecondary, color: theme.colors.text },
                          ]}
                        />
                        <TextInput
                          value={file.albumName}
                          onChangeText={(albumName) => updateFile(file.key, { albumName })}
                          placeholder={t('uploads.details.album')}
                          placeholderTextColor={theme.colors.textSecondary}
                          editable={!isUploading}
                          style={[
                            styles.input,
                            { backgroundColor: theme.colors.backgroundSecondary, color: theme.colors.text },
                          ]}
                        />
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
                    <Text style={[styles.fileMeta, { color: theme.colors.textSecondary }]}>
                      {t('uploads.uploading')}
                    </Text>
                  </View>
                )}

                {failure && !outcome && (
                  <Text style={[styles.failureText, { color: theme.colors.error }]}>{failure}</Text>
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
              style={[styles.attestation, { backgroundColor: theme.colors.backgroundTertiary }]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: attestationAccepted }}
            >
              <Ionicons
                name={attestationAccepted ? 'checkbox' : 'square-outline'}
                size={22}
                color={attestationAccepted ? theme.colors.primary : theme.colors.textSecondary}
              />
              <View style={styles.attestationText}>
                <Text style={[styles.attestationTitle, { color: theme.colors.text }]}>
                  {t('uploads.attestation.title')}
                </Text>
                <Text style={[styles.attestationBody, { color: theme.colors.textSecondary }]}>
                  {attestationStatement}
                </Text>
              </View>
            </Pressable>
          )}

          {attestationMissing && (
            <Text style={[styles.failureText, { color: theme.colors.error }]}>
              {t('uploads.attestation.required')}
            </Text>
          )}
        </ScrollView>

        {pendingFiles.length > 0 && (
          <View
            style={[
              styles.footer,
              {
                backgroundColor: theme.colors.backgroundSecondary,
                borderTopColor: theme.colors.border,
                paddingBottom: 16 + insets.bottom,
              },
            ]}
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
