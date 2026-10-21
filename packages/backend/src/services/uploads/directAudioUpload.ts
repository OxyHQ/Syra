/**
 * How audio bytes reach the four routes that take them — directly from storage,
 * or (for clients that predate it) in the request body.
 *
 * `api.syra.fm` is behind a proxy that refuses any request body over 100 MB, and
 * these routes accept up to 200 MB (`POST /api/tracks/upload`, `POST
 * /api/uploads`) and 500 MB (`POST /api/podcasts/:id/episodes`, `POST
 * /api/podcasts/episodes/:id/ingest`). So a client asks for a presigned PUT
 * ({@link createAudioUploadTarget}), sends the file straight to storage under
 * `incoming/`, and then calls the route it always called with `{ uploadId }`
 * where the file used to be. The shared contract is
 * `@syra/shared-types`'s `audioUpload.ts`.
 *
 * ## One route body, two ways in
 *
 * Every route reads its file through {@link audioIntake}, which hands back the
 * SAME {@link ReceivedAudio} whichever way the bytes came: a local file for the
 * processes that read a path (ffprobe, fpcalc, music-metadata), and a way to
 * store it as the ORIGINAL at the key the route always wrote. Everything after
 * that — probing, fingerprinting, dedup, screening, the rows, the ingest queue,
 * the response — is unchanged and shared, so an upload's outcome cannot depend
 * on how its bytes travelled.
 *
 * The multipart way in stays because a published contract still uses it:
 * `@syra.fm/sdk` ≤ 0.21 sends `ingestEpisode` as multipart, and an installed app
 * keeps sending what its bundle sends until it updates. Through the proxy it
 * works for files up to 100 MB, which is every file those callers sent before.
 *
 * ## What the direct way keeps enforced
 *
 * - Size: the declared size must be within the route's cap, and it is a SIGNED
 *   header — storage refuses a body of any other length. The completing route
 *   checks the stored object's size against the cap again.
 * - Type: the Content-Type validated when the URL was signed is a signed header
 *   too, and the completing route re-reads the stored object's type and maps it
 *   through the same table multer's filter uses.
 * - Ownership: the incoming key embeds the caller (`account/{oxyUserId}` or
 *   `ticket/{episodeId}`), and the completing route derives it from ITS caller,
 *   so naming somebody else's `uploadId` finds nothing.
 * - "Dedup before a byte is stored": an incoming object is not stored audio. It
 *   is deleted on every exit of the completing route, and nothing reads it but
 *   that route.
 *
 * ## What the bucket must allow
 *
 * A browser PUTs cross-origin, so the store's CORS must admit `PUT` with a
 * `Content-Type` request header from `https://syra.fm` and
 * `https://studio.syra.fm` — on R2's `syra-media` once it is the store, and on
 * the S3 media bucket while it still is. React Native and a server-side SDK
 * caller send no `Origin` and are not subject to CORS. The URL is signed with
 * the store's own credential, which needs only PutObject, plus the
 * Get/Copy/Delete/List the completing route and the abandoned-upload sweep use.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, RequestHandler } from 'express';
import multer from 'multer';
import { uuidv7 } from '@oxy.so/db';
import {
  audioUploadReferenceSchema,
  type AudioFormat,
  type AudioUploadPurpose,
  type AudioUploadTarget,
} from '@syra/shared-types';
import {
  AUDIO_UPLOAD_REJECTED_MESSAGE,
  MAX_UPLOAD_BYTES_BY_PURPOSE,
  audioFormatFor,
  isAllowedAudioMime,
} from '../../config/audioUpload';
import {
  deleteAudioObject,
  deleteAudioObjects,
  getS3IncomingAudioKey,
  listIncomingAudio,
  presignIncomingAudio,
  promoteIncomingAudio,
  putSourceAudio,
  stageAudioObject,
  statAudioObject,
  type AudioOwner,
  type AudioPutOptions,
} from '../oxyFiles/audioStorage';
import { logger } from '../../utils/logger';
import { describeErrorSafely, getErrorMessage } from '../../utils/error';

/** The multipart field every audio route reads its file from. */
const MULTIPART_AUDIO_FIELD = 'audioFile';

/**
 * How long a presigned URL stays usable. Storage checks it when the upload
 * STARTS, so a slow transfer that began in time completes; an hour is long
 * enough for a client to pick a file and begin, and short enough that a leaked
 * URL is worth little — it admits one object of one exact size anyway.
 */
export const DIRECT_UPLOAD_TTL_SECONDS = 60 * 60;

/**
 * An incoming object older than this was abandoned: its URL expired long ago
 * and no completing route still holds it. Deleted by
 * {@link sweepAbandonedAudioUploads}.
 */
export const ABANDONED_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000;

/** `uuidv7()`'s shape — the only ids {@link createAudioUploadTarget} mints. */
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** One path segment of an object key: no `/`, no `.` or `..`, nothing to escape. */
const KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;

// ── Who is uploading ─────────────────────────────────────────────────────────

/**
 * The caller an incoming object belongs to — a signed-in account, or the holder
 * of one episode's ingest ticket (who has no account on the call at all).
 */
export type AudioUploadPrincipal =
  | { kind: 'account'; oxyUserId: string }
  | { kind: 'ingest-ticket'; episodeId: string };

function principalSegment(principal: AudioUploadPrincipal): string {
  const [label, id] =
    principal.kind === 'account'
      ? ['account', principal.oxyUserId]
      : ['ticket', principal.episodeId];
  // Both ids come from a verified credential, never from the body — but the key
  // is a path, and a value that could climb out of its segment would turn
  // "derive the key from the caller" into "the caller chooses the key".
  if (!KEY_SEGMENT.test(id)) {
    throw new Error(`directAudioUpload: ${label} id is not a safe key segment`);
  }
  return `${label}/${id}`;
}

function incomingKey(
  purpose: AudioUploadPurpose,
  principal: AudioUploadPrincipal,
  uploadId: string,
): string {
  return getS3IncomingAudioKey(purpose, principalSegment(principal), uploadId);
}

// ── Refusals ─────────────────────────────────────────────────────────────────

/** A refusal a route answers with as-is: the status and the JSON body. */
export interface AudioUploadRefusal {
  status: number;
  body: { error: string; message: string };
}

const REFUSE_TYPE: AudioUploadRefusal = {
  status: 400,
  body: { error: 'Upload error', message: AUDIO_UPLOAD_REJECTED_MESSAGE },
};
const REFUSE_SIZE: AudioUploadRefusal = {
  status: 413,
  body: { error: 'Upload error', message: 'File too large' },
};

// ── Step 1: the presigned PUT ────────────────────────────────────────────────

/**
 * A presigned PUT for one upload, or the refusal a client is owed before it
 * transfers anything: a type Syra does not accept, or a size over the cap of
 * the route that will complete it.
 */
export async function createAudioUploadTarget(input: {
  purpose: AudioUploadPurpose;
  principal: AudioUploadPrincipal;
  mimeType: string;
  sizeBytes: number;
}): Promise<{ ok: true; target: AudioUploadTarget } | { ok: false; refusal: AudioUploadRefusal }> {
  const maxBytes = MAX_UPLOAD_BYTES_BY_PURPOSE[input.purpose];
  if (!isAllowedAudioMime(input.mimeType)) return { ok: false, refusal: REFUSE_TYPE };
  if (input.sizeBytes > maxBytes) return { ok: false, refusal: REFUSE_SIZE };

  const uploadId = uuidv7();
  const { url, headers } = await presignIncomingAudio(
    incomingKey(input.purpose, input.principal, uploadId),
    {
      contentType: input.mimeType,
      contentLength: input.sizeBytes,
      expiresInSeconds: DIRECT_UPLOAD_TTL_SECONDS,
    },
  );

  return {
    ok: true,
    target: {
      uploadId,
      url,
      method: 'PUT',
      headers,
      maxBytes,
      expiresAt: new Date(Date.now() + DIRECT_UPLOAD_TTL_SECONDS * 1000).toISOString(),
    },
  };
}

// ── Step 3: the completing route's file ──────────────────────────────────────

/** The file a route received, however it travelled. */
export interface ReceivedAudio {
  /** The declared type, already checked against the allowlist. */
  readonly mimeType: string;
  readonly format: AudioFormat;
  /** The name the file had on the uploader's device ('' when none was given). */
  readonly originalName: string;
  readonly sizeBytes: number;
  /** A local file holding the bytes — what ffprobe, fpcalc and the tag reader open. */
  localPath(): Promise<string>;
  /** Store the bytes as the ORIGINAL at `key`, as `putSourceAudio` does. */
  storeAsSource(key: string, options: AudioPutOptions & { owner: AudioOwner }): Promise<void>;
}

export type ReceiveResult =
  | { kind: 'received'; audio: ReceivedAudio }
  /** Neither a multipart file nor an `uploadId`: the route's own "file required" answer. */
  | { kind: 'missing' }
  | { kind: 'refused'; refusal: AudioUploadRefusal };

/** A route's handle on its incoming file. {@link AudioIntake.dispose} on EVERY exit. */
export interface AudioIntake {
  /**
   * The file, as `principal` uploaded it. Looks at storage only for a direct
   * upload, and only under the key `principal` owns.
   */
  receive(principal: AudioUploadPrincipal): Promise<ReceiveResult>;
  /**
   * Remove every copy this request made or was handed: the multipart temp file,
   * the locally staged copy, and the incoming object. Never throws — a failed
   * cleanup is logged, and the abandoned-upload sweep is the net under it.
   */
  dispose(): Promise<void>;
}

async function removeTempFile(tempPath: string): Promise<void> {
  // `force` makes an already-removed file a no-op; any other failure is a real
  // disk problem and is logged rather than swallowed.
  await fs.promises.rm(tempPath, { force: true }).catch((rmError: unknown) =>
    logger.warn('[directAudioUpload] failed to remove upload temp file', {
      tempPath,
      message: getErrorMessage(rmError),
    }),
  );
}

function multipartAudio(file: Express.Multer.File): ReceivedAudio {
  // Never undefined: multer's filter refused anything not on the same table.
  const format = audioFormatFor(file.mimetype) ?? 'mp3';
  return {
    mimeType: file.mimetype,
    format,
    originalName: file.originalname,
    sizeBytes: file.size,
    localPath: async () => file.path,
    // Streamed from the temp file: the S3 client derives Content-Length from the
    // ReadStream's path, so the upload is never held in memory.
    storeAsSource: (key, options) => putSourceAudio(key, fs.createReadStream(file.path), options),
  };
}

/**
 * The intake for one request on a route completed as `purpose`. Construct it
 * FIRST — before anything that can return — so the multipart temp file has an
 * owner on every path, the early 4xx and 503 answers included.
 */
export function audioIntake(req: Request, purpose: AudioUploadPurpose): AudioIntake {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  /** Everything to remove at the end, recorded as it comes into existence. */
  const tempFiles: string[] = file ? [file.path] : [];
  const incomingKeys: string[] = [];

  async function receiveDirect(
    principal: AudioUploadPrincipal,
    rawUploadId: unknown,
  ): Promise<ReceiveResult> {
    const reference = audioUploadReferenceSchema.safeParse({
      uploadId: rawUploadId,
      fileName: typeof req.body?.fileName === 'string' ? req.body.fileName : undefined,
    });
    if (!reference.success || !UPLOAD_ID.test(reference.data.uploadId)) {
      return {
        kind: 'refused',
        refusal: {
          status: 400,
          body: {
            error: 'Invalid upload',
            message: 'uploadId must be the id an upload request returned.',
          },
        },
      };
    }

    const key = incomingKey(purpose, principal, reference.data.uploadId);
    const stored = await statAudioObject(key);
    if (!stored) {
      // Also the answer for an id another caller owns: their key is not this one.
      return {
        kind: 'refused',
        refusal: {
          status: 400,
          body: {
            error: 'Upload not found',
            message: 'The uploaded file was not found. It may have expired; upload it again.',
          },
        },
      };
    }
    // From here the object is this request's to delete, refused or not.
    incomingKeys.push(key);

    const sizeBytes = stored.contentLength ?? 0;
    if (sizeBytes > MAX_UPLOAD_BYTES_BY_PURPOSE[purpose]) {
      return { kind: 'refused', refusal: REFUSE_SIZE };
    }
    const mimeType = stored.contentType ?? '';
    const format = audioFormatFor(mimeType);
    if (!format) return { kind: 'refused', refusal: REFUSE_TYPE };

    let staged: Promise<string> | undefined;
    return {
      kind: 'received',
      audio: {
        mimeType,
        format,
        originalName: reference.data.fileName ?? '',
        sizeBytes,
        localPath: () => {
          staged ??= (async () => {
            const localPath = path.join(os.tmpdir(), `syra-upload-${reference.data.uploadId}`);
            tempFiles.push(localPath);
            if (!(await stageAudioObject(key, localPath))) {
              throw new Error('directAudioUpload: the incoming object vanished before staging');
            }
            return localPath;
          })();
          return staged;
        },
        storeAsSource: (destination, options) => promoteIncomingAudio(key, destination, options),
      },
    };
  }

  return {
    async receive(principal) {
      if (file) return { kind: 'received', audio: multipartAudio(file) };
      const uploadId: unknown = req.body?.uploadId;
      if (uploadId === undefined) return { kind: 'missing' };
      return receiveDirect(principal, uploadId);
    },

    async dispose() {
      await Promise.all(tempFiles.map(removeTempFile));
      await Promise.all(
        incomingKeys.map((key) =>
          deleteAudioObject(key).catch((error: unknown) =>
            logger.warn('[directAudioUpload] failed to delete an incoming upload', {
              key,
              error: describeErrorSafely(error),
            }),
          ),
        ),
      );
    },
  };
}

// ── The multipart way in ─────────────────────────────────────────────────────

/**
 * The multipart parser for a route completed as `purpose`: the file under
 * `audioFile`, written to a temp file (ffprobe, fpcalc and the tag reader read a
 * path, and a 500 MB Buffer per request does not survive upload volume), capped
 * and filtered by the same tables the direct upload uses. Multer removes its own
 * temp file when the parse fails; after a successful parse it belongs to
 * {@link audioIntake}.
 *
 * A JSON request passes through untouched — multer acts only on multipart — so
 * a route mounts this once and serves both ways in.
 */
export function multipartAudioParser(purpose: AudioUploadPurpose): RequestHandler {
  return multer({
    storage: multer.diskStorage({ destination: os.tmpdir() }),
    limits: { fileSize: MAX_UPLOAD_BYTES_BY_PURPOSE[purpose] },
    fileFilter: (_req, file, cb) => {
      if (isAllowedAudioMime(file.mimetype)) cb(null, true);
      else cb(new Error(AUDIO_UPLOAD_REJECTED_MESSAGE));
    },
  }).single(MULTIPART_AUDIO_FIELD);
}

// ── Abandoned uploads ────────────────────────────────────────────────────────

/**
 * Delete every incoming object older than {@link ABANDONED_UPLOAD_AGE_MS}: a
 * file somebody uploaded and never completed. Safe to run on every instance at
 * once — the age bound keeps it a day away from any upload still in flight, and
 * deleting an object twice is not an error.
 */
export async function sweepAbandonedAudioUploads(now: Date = new Date()): Promise<number> {
  const abandoned: string[] = [];
  for await (const object of listIncomingAudio()) {
    if (
      object.lastModified &&
      now.getTime() - object.lastModified.getTime() > ABANDONED_UPLOAD_AGE_MS
    ) {
      abandoned.push(object.key);
    }
  }
  return abandoned.length > 0 ? deleteAudioObjects(abandoned) : 0;
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Delayed so the first sweep never competes with cold-start boot work. */
const SWEEP_INITIAL_DELAY_MS = 10 * 60 * 1000;
let sweeperStarted = false;

/**
 * Sweep abandoned uploads hourly on this instance. Idempotent. The timers are
 * `unref`'d: nothing here justifies holding the process open.
 */
export function startAbandonedAudioUploadSweeper(): void {
  if (sweeperStarted) return;
  sweeperStarted = true;

  const tick = async (): Promise<void> => {
    try {
      const deleted = await sweepAbandonedAudioUploads();
      if (deleted > 0) logger.info('[directAudioUpload] swept abandoned uploads', { deleted });
    } catch (error) {
      logger.error('[directAudioUpload] abandoned-upload sweep failed', {
        error: describeErrorSafely(error),
      });
    }
  };

  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), SWEEP_INTERVAL_MS).unref?.();
  }, SWEEP_INITIAL_DELAY_MS).unref?.();
}
