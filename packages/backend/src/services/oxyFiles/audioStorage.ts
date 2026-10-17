/**
 * Syra's AUDIO storage — the one seam between every audio path in Syra and the
 * place audio bytes live. Every track source, HLS ladder, locker upload,
 * episode, enclosure cache, preview clip and room recording is written, read,
 * signed, played and deleted through this module and nothing else
 * (`audioStorage.boundary.test.ts` fails the build on a direct S3 import, and on
 * any other importer of `oxyAudio.ts`).
 *
 * ## Two stores, one decision
 *
 * - **Oxy Files** (OxyHQ/oxy ADR 0043, stage 4c — `oxyAudio.ts`) is where a
 *   listener's audio comes from: each audio-bearing row names a PRIVATE Oxy
 *   file (`tracks.audio_file_id`, `user_uploads.audio_file_id`,
 *   `episodes.audio_file_id`, `recordings.oxy_file_id`), Oxy renders its
 *   audio-only HLS ladder, waveform and 30-second preview, and a play is a
 *   per-listener, revocable play session whose AES-128 key Oxy releases only
 *   after Syra's file-events endpoint allows it (`audioKeyAuthorization.ts`).
 *   Enclosures are imported by Oxy from their URL (up to 8 GiB); room
 *   recordings are written by LiveKit egress straight into an Oxy recording
 *   target.
 * - **The bucket** keeps every ORIGINAL Syra received — the input of every
 *   process Syra still runs itself on the raw bytes: ingest and re-ingest,
 *   fingerprinting, promoting a locker file to the catalogue, a preview at a
 *   listener-chosen offset, a track played into a LiveKit room — and, for a
 *   row Oxy does not serve yet, the legacy ladder that plays it. The owner a
 *   caller names is stored on the object (`oxy-owner`).
 *
 * `OXY_AUDIO` (`oxyAudio.ts`) decides which one a NEW file reaches and whether
 * a play may come from Oxy: `legacy` (the default — nothing calls Oxy for audio
 * at runtime), `dual` (both; Oxy preferred, the legacy ladder still built), or
 * `oxy` (no legacy ladder unless Oxy refused the file). Every Oxy refusal falls
 * back to the legacy path; a file Oxy reported withdrawn plays from neither.
 * Existing audio moves with `scripts/migrateAudioToOxy.ts` (preview, then
 * `--apply`), whose `retire` step deletes the legacy ladders Oxy has replaced;
 * `docs/runbooks/oxy-files-audio.md` is the procedure.
 */

import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'stream';
import {
  S3_BUCKET_NAME,
  S3_ENDPOINT,
  S3_REGION,
  getS3AudioKey,
  getS3HlsKey,
  getS3LockerAudioKey,
  getS3LockerHlsKey,
  getS3LockerHlsPrefix,
  getS3PodcastEpisodeAudioKey,
  getS3PodcastEpisodeCacheKey,
  getS3PodcastEpisodeHlsPrefix,
  getS3PodcastShowPrefixes,
  getS3PreviewKey,
} from '../../config/s3.config';
import {
  deleteFromS3,
  deleteFromS3Batch,
  deleteS3Prefix,
  getObjectMetadata,
  getPresignedUrl,
  objectExists,
  streamFromS3,
  uploadToS3,
} from '../s3Service';
import { logger } from '../../utils/logger';
import { describeErrorSafely } from '../../utils/error';
import {
  attachAudioFile,
  collectRecording,
  createRecordingTarget,
  originalDownloadUrl,
  oxyAudioEnabled,
  oxyErrorOf,
  revokePlaySessions,
  type AudioOwner,
} from './oxyAudio';

// The object keys, unchanged: they are where audio IS, and every row that stores
// one stores this spelling.
export {
  getS3AudioKey,
  getS3HlsKey,
  getS3LockerAudioKey,
  getS3LockerHlsKey,
  getS3LockerHlsPrefix,
  getS3PodcastEpisodeAudioKey,
  getS3PodcastEpisodeCacheKey,
  getS3PodcastEpisodeHlsPrefix,
  getS3PodcastShowPrefixes,
  getS3PreviewKey,
};

export type { AudioOwner } from './oxyAudio';

export interface AudioPutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface AudioRange {
  start?: number;
  end?: number;
}

function ownerTag(owner: AudioOwner): string {
  return owner.kind === 'application' ? 'application' : `account:${owner.oxyUserId}`;
}

/**
 * Store an ORIGINAL — the bytes somebody uploaded or Syra mirrored — in the
 * bucket, the input of every process Syra runs on the raw bytes. Its Oxy copy
 * is made by ingest ({@link mirrorAudioToOxy}), from the same bytes.
 */
export async function putSourceAudio(
  key: string,
  body: Buffer | Readable | string,
  options: AudioPutOptions & { owner: AudioOwner },
): Promise<void> {
  const { owner, ...rest } = options;
  await uploadToS3(key, body, {
    ...rest,
    metadata: { ...(rest.metadata ?? {}), 'oxy-owner': ownerTag(owner) },
  });
}

/**
 * Store something Syra DERIVED from an original — an HLS playlist or segment, a
 * preview clip: the legacy ladder, built in `legacy` and `dual` mode or when
 * Oxy refused a file. Oxy renders its own for every file it stores.
 */
export async function putDerivedAudio(
  key: string,
  body: Buffer | Readable | string,
  options: AudioPutOptions = {},
): Promise<void> {
  await uploadToS3(key, body, options);
}

/** Read an audio object, whole or a byte range. */
export function openAudioObject(
  key: string,
  range: AudioRange = {},
): Promise<{
  stream: Readable;
  contentLength: number;
  contentType?: string;
  contentRange?: string;
}> {
  return streamFromS3(key, range);
}

export function statAudioObject(key: string) {
  return getObjectMetadata(key);
}

export function audioObjectExists(key: string): Promise<boolean> {
  return objectExists(key);
}

/** A time-limited URL for one bucket object (a legacy segment, an original). */
export function presignAudioObject(key: string, expiresInSeconds = 3600): Promise<string> {
  return getPresignedUrl(key, expiresInSeconds);
}

/**
 * Copy one bucket object to a local file — what the Oxy backfill uploads from.
 * `false` when the object is not in the bucket.
 */
export async function stageAudioObject(key: string, localPath: string): Promise<boolean> {
  if (!(await getObjectMetadata(key))) return false;
  const { stream } = await streamFromS3(key);
  await pipeline(stream, createWriteStream(localPath));
  return true;
}

export function deleteAudioObject(key: string): Promise<void> {
  return deleteFromS3(key);
}

export function deleteAudioObjects(keys: readonly string[]): Promise<number> {
  return deleteFromS3Batch(keys);
}

/** Delete every object under a prefix. The caller owns the prefix being exactly one thing's. */
export function deleteAudioPrefix(prefix: string): Promise<number> {
  return deleteS3Prefix(prefix);
}

// ── Room recordings ──────────────────────────────────────────────────────

export function getRecordingObjectKey(roomId: string, recordingId: string): string {
  return `agora/recordings/${roomId}/${recordingId}.ogg`;
}

/**
 * The legacy egress output: a room recording straight into the bucket. It
 * passes the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` pair only when both
 * are set (local MinIO). Production sets neither: with no credentials in the
 * request, LiveKit's S3 uploader uses the AWS default chain on the LiveKit host,
 * whose instance role (`oxy-livekit` in oxy-infra) may put only under
 * `agora/recordings/`. Used in `legacy` mode, and whenever Oxy refuses a
 * recording target ({@link recordingStorage}).
 */
export function recordingEgressTarget(objectKey: string) {
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.AWS_SECRET_ACCESS_KEY;
  return {
    ...(accessKey && secret ? { accessKey, secret } : {}),
    bucket: S3_BUCKET_NAME,
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    filepath: objectKey,
    forcePathStyle: Boolean(S3_ENDPOINT),
  };
}

/** Where a new room recording is written, and how Syra finds it afterwards. */
export interface RecordingStorage {
  /** The object key LiveKit writes (`recordings.object_key`). */
  objectKey: string;
  /** LiveKit's `S3Upload` for that key. */
  s3: {
    accessKey?: string;
    secret?: string;
    bucket: string;
    region: string;
    endpoint?: string;
    forcePathStyle: boolean;
  };
  /** The Oxy recording target, when the recording goes into Oxy Files. */
  oxyRecordingTargetId: string | null;
}

/**
 * Where a new room recording goes: an Oxy recording target (Syra's own private
 * file, collected once Oxy verified it) when `OXY_AUDIO` allows it and Oxy
 * answers, the bucket otherwise.
 */
export async function recordingStorage(input: {
  roomId: string;
  recordingId: string;
  maxDurationSec: number;
}): Promise<RecordingStorage> {
  const legacyKey = getRecordingObjectKey(input.roomId, input.recordingId);
  if (oxyAudioEnabled()) {
    try {
      const target = await createRecordingTarget(input);
      return {
        objectKey: target.livekit.filepath,
        s3: {
          accessKey: target.s3.accessKey,
          secret: target.s3.secret,
          bucket: target.s3.bucket,
          region: target.s3.region,
          endpoint: target.s3.endpoint,
          forcePathStyle: target.s3.forcePathStyle,
        },
        oxyRecordingTargetId: target.targetId,
      };
    } catch (error) {
      logger.warn('[AudioStorage] no Oxy recording target; recording into the bucket', {
        roomId: input.roomId,
        ...oxyErrorOf(error),
        error: describeErrorSafely(error),
      });
    }
  }
  return {
    objectKey: legacyKey,
    s3: (({ filepath: _filepath, ...upload }) => upload)(recordingEgressTarget(legacyKey)),
    oxyRecordingTargetId: null,
  };
}

/**
 * A short-lived URL a recording plays from: its Oxy file's original (collected
 * from the target on first read), or the bucket object. `null` while Oxy has
 * not finished the recording, or when its file was withdrawn.
 */
export async function recordingPlaybackUrl(recording: {
  id: string;
  objectKey: string;
  oxyFileId: string | null;
  oxyRecordingTargetId: string | null;
}): Promise<string | null> {
  if (recording.oxyRecordingTargetId === null && recording.oxyFileId === null) {
    return presignAudioObject(recording.objectKey);
  }
  const fileId =
    recording.oxyFileId ??
    (recording.oxyRecordingTargetId
      ? await collectRecording(recording.id, recording.oxyRecordingTargetId)
      : null);
  return fileId ? originalDownloadUrl(fileId) : null;
}

/**
 * Delete a recording's audio. A bucket recording's object goes now; an Oxy
 * recording is let go by clearing its column (the trigger removes Syra's
 * reference, and Oxy deletes an application file nobody uses), and any
 * session playing it stops.
 */
export async function deleteRecordingAudio(recording: {
  id: string;
  objectKey: string;
  oxyFileId: string | null;
  oxyRecordingTargetId: string | null;
}): Promise<void> {
  if (recording.oxyRecordingTargetId === null && recording.oxyFileId === null) {
    await deleteFromS3(recording.objectKey);
    return;
  }
  if (recording.oxyFileId) {
    await attachAudioFile({ kind: 'recording', id: recording.id }, null);
    await revokePlaySessions({ fileId: recording.oxyFileId });
  }
}

// ── Oxy Files (stage 4c) — the only way in to `oxyAudio.ts` ──────────────

export {
  AUDIO_REFERENCE_ENTITY_TYPES,
  OXY_AUDIO_MODES,
  attachAudioFile,
  audioFileState,
  audioMimeFor,
  collectRecording as collectRecordingFile,
  importEnclosureToOxy,
  laddersReady,
  mirrorAudioToOxy,
  openPlaySession,
  originalDownloadUrl,
  oxyAudioEnabled,
  oxyAudioMode,
  revokePlaySessions,
  setAudioFileStatus,
  sha256OfFile,
  storeAudioInOxy,
  type AudioEntity,
  type OxyAudioMode,
  type OxyPlayback,
  type OxyPlaybackResult,
  type StoredOxyAudio,
} from './oxyAudio';
export { authorizeAudioKey } from './audioKeyAuthorization';
