/**
 * Syra's AUDIO storage — the one seam between every audio path in Syra and the
 * place audio bytes live. Every track source, HLS ladder, locker upload,
 * episode, enclosure cache, preview clip and room recording is written, read,
 * signed and deleted through this module and nothing else
 * (`audioStorage.boundary.test.ts` fails the build on a direct S3 import).
 *
 * ## Why audio is still in Syra's bucket — measured, not assumed
 *
 * Images moved to Oxy Files (ADR 0041, `oxyFiles/images.ts`); audio cannot yet,
 * because Oxy Files does not take it. Read off the Oxy API on the ADR 0041
 * branch (stages 1–4a):
 *
 * - `POST /assets/service/app` and `/service/user-media` refuse anything but
 *   `image/*` and `video/*` (415), at most 40 MiB, in one request body; the
 *   imports by URL refuse the same. A lossless album track, a two-hour episode
 *   and a room recording are all audio, and routinely larger.
 * - `/service/user-media` stores PUBLIC files only (it takes no visibility). A
 *   locker upload is a person's private music.
 * - The rendition pipeline (`variantService`) renders images, video and PDF. It
 *   has no audio path: no audio-only HLS ladder, no 30-second preview. Its HLS is
 *   a VIDEO ladder; it cannot be pointed at an audio file.
 * - A private file is read back by an application only through
 *   `linkedDownloadUrls` — one URL per file, and only for a file its owner linked
 *   to the application. Streaming needs a playlist plus hundreds of segment URLs
 *   behind ONE entitlement decision that Syra makes per play (playability,
 *   copyright takedowns, locker ownership, bitrate tier), and AES keys whose
 *   delivery Syra gates (`trackKeys`, `stream.controller`).
 * - LiveKit egress writes a room recording straight into an S3 bucket; Oxy has
 *   no upload target an external writer can be pointed at.
 *
 * ## What Oxy must add before audio moves — TODO(oxy-4b)
 *
 * Stage 4b ("large/any-type application uploads, presigned multipart, up to 8
 * GiB") is the first item; it is not the last:
 *
 * 1. Any-MIME, multipart uploads (≤ 8 GiB) for an application's files AND a
 *    person's (`uploadAppFile` / `uploadUserMedia` with `audio/*`), with
 *    `visibility: 'private'` on the person's — the locker.
 * 2. An audio rendition pipeline: an audio-only adaptive HLS ladder (AAC
 *    64/128/256 kbps at least) announced by `hlsReadyAt`, and a short preview
 *    clip rendition at a given offset.
 * 3. Entitled private streaming: an application-minted, short-lived playback
 *    grant for one private file's whole HLS ladder (master, rendition playlists,
 *    segments), refusable per play — plus per-file content keys whose delivery
 *    the application gates, so a takedown or a lapsed entitlement stops playback.
 * 4. A presigned upload target an external writer can use (LiveKit egress), or
 *    an import of a presigned source, for recordings.
 * 5. Import by URL for `audio/*` larger than 40 MiB — the RSS enclosure cache.
 *
 * When those exist, this module is where the switch happens: `putSourceAudio`
 * becomes `uploadAppFile` (catalogue, enclosure cache) or `uploadUserMedia`
 * (a creator's track, a locker file, a hosted show's episode) with the owner its
 * caller already names; `putDerivedAudio` and the HLS/preview builders go away,
 * because Oxy renders them; `presignAudioObject` and `openAudioObject` become the
 * playback grant; recordings get the external upload target. The rows that hold
 * object keys then hold Oxy file ids, copied by a migration shaped like
 * `scripts/migrateImagesToOxy.ts` (verified per file, resumable, dual-read), and
 * the bucket is retired by a gate like `retireLegacyImageStorage.ts`'s.
 *
 * Until then: the bucket, unchanged. The owner a caller names is stored on the
 * object (`oxy-owner` metadata), so the eventual copy knows whose file each one
 * is without re-deriving it.
 */

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

/** Who an audio file belongs to — the owner it gets in Oxy Files once audio moves. */
export type AudioOwner =
  /** Syra's own: the catalogue, a mirrored RSS enclosure. */
  | { kind: 'application' }
  /** A person's: a creator's upload, a locker file, a hosted show's episode. */
  | { kind: 'account'; oxyUserId: string };

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
 * Store an ORIGINAL — the bytes somebody uploaded or Syra mirrored, which Oxy
 * Files will own one day. TODO(oxy-4b): `uploadAppFile` / `uploadUserMedia`.
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
 * preview clip. TODO(oxy-4b): rendered by Oxy's audio pipeline, so it goes away.
 */
export async function putDerivedAudio(
  key: string,
  body: Buffer | Readable | string,
  options: AudioPutOptions = {},
): Promise<void> {
  await uploadToS3(key, body, options);
}

/** Read an audio object, whole or a byte range. TODO(oxy-4b): the playback grant. */
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

/** A time-limited URL for one object. TODO(oxy-4b): the playback grant. */
export function presignAudioObject(key: string, expiresInSeconds = 3600): Promise<string> {
  return getPresignedUrl(key, expiresInSeconds);
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
 * Where LiveKit egress writes a room recording: straight into the bucket. It
 * passes the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` pair only when both
 * are set (local MinIO). Production sets neither: with no credentials in the
 * request, LiveKit's S3 uploader uses the AWS default chain on the LiveKit host,
 * whose instance role (`oxy-livekit` in oxy-infra) may put only under
 * `agora/recordings/`. TODO(oxy-4b): an Oxy upload target egress can write to.
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
