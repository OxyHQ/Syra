/**
 * Syra's audio in Oxy Files (OxyHQ/oxy ADR 0043, stage 4c) — the Oxy half of
 * the audio seam. Imported by `audioStorage.ts` ONLY
 * (`audioStorage.boundary.test.ts`): every other module reaches it through the
 * seam, so there is one place where "does this play from Oxy or from the
 * bucket" is decided.
 *
 * What lives here:
 *
 * - **Storing.** An original Syra holds locally (an ingest's temp file, the
 *   backfill's staged copy) becomes a PRIVATE Oxy file — the Syra
 *   application's for the catalogue, a mirrored enclosure and a room recording;
 *   the person's for a locker upload and a hosted show's episode. Oxy renders an
 *   audio-only HLS ladder (AAC 64/128/256 kbps), a waveform and a 30-second
 *   preview from it. The SHA-256 Oxy answers is checked against the bytes sent.
 * - **Importing.** A podcast enclosure is imported BY OXY from its URL — up to
 *   8 GiB; one over 40 MiB is fetched in the background and the SDK waits.
 * - **Playing.** A play is a per-listener, revocable Oxy play session: AES-128,
 *   and the key is released only after Syra's file-events endpoint allows it
 *   (`keyAuthorization: 'webhook'`, answered by `audioKeyAuthorization.ts`).
 * - **Recording.** LiveKit egress writes a room recording into an Oxy recording
 *   target; the file is collected once Oxy verified it.
 *
 * ## Safe before Oxy's stage 4c is live
 *
 * `OXY_AUDIO` (default `legacy`) gates every runtime call here: in `legacy`
 * nothing in this module is reached outside the operator-run backfill. In
 * `dual` and `oxy`, any refusal — a 404 for a route Oxy does not serve yet, a
 * 415 for audio an Oxy without stage 4c refuses, a 409 for a ladder not yet
 * rendered, a network error — is an answer of "not from Oxy", and the caller
 * takes the legacy path it always had. Nothing here throws into a request.
 */

import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import type { CreatedRecordingTarget, PlaySession } from '@oxy.so/core';
import { getDb } from '../../db/postgres';
import { tracks } from '../../db/schema/catalog';
import { userUploads } from '../../db/schema/creators';
import { episodes } from '../../db/schema/podcasts';
import { recordings } from '../../db/schema/rooms';
import {
  oxyAudioFiles,
  type OxyAudioFileStatus,
  type OxyReferenceEntityType,
} from '../../db/schema/oxyFiles';
import { logger } from '../../utils/logger';
import { describeErrorSafely } from '../../utils/error';
import { oxyFiles } from './client';

// ── Mode ──────────────────────────────────────────────────────────────────────

/**
 * How Syra stores and plays audio (`OXY_AUDIO`):
 *
 * - `legacy` (the default): the bucket only, exactly as before stage 4c.
 *   Nothing calls Oxy for audio at runtime.
 * - `dual`: new audio is ALSO stored in Oxy, and a row whose Oxy ladder is ready
 *   plays from Oxy; Syra's own ladder is still built, so every play has the
 *   legacy path to fall back to. The setting to run the backfill under.
 * - `oxy`: new audio is stored in Oxy and Syra builds no ladder of its own —
 *   unless Oxy refused the file, in which case the legacy ingest runs as before.
 */
export const OXY_AUDIO_MODES = ['legacy', 'dual', 'oxy'] as const;
export type OxyAudioMode = (typeof OXY_AUDIO_MODES)[number];

export function oxyAudioMode(): OxyAudioMode {
  const value = process.env.OXY_AUDIO?.trim();
  return value === 'dual' || value === 'oxy' ? value : 'legacy';
}

/** Whether audio may be stored in, and played from, Oxy at runtime. */
export function oxyAudioEnabled(): boolean {
  return oxyAudioMode() !== 'legacy';
}

// ── Entities and owners ──────────────────────────────────────────────────────

/** A row that plays one audio file. */
export type AudioEntity =
  | { kind: 'track'; id: string }
  | { kind: 'user_upload'; id: string }
  | { kind: 'episode'; id: string }
  | { kind: 'recording'; id: string };

/** The reference entity type each kind of row uses its audio file as. */
export const AUDIO_REFERENCE_ENTITY_TYPES = {
  track: 'track_audio',
  user_upload: 'user_upload_audio',
  episode: 'episode_audio',
  recording: 'recording',
} as const satisfies Record<AudioEntity['kind'], OxyReferenceEntityType>;

/** Who an audio file belongs to in Oxy. */
export type AudioOwner =
  /** Syra's own: the catalogue, a mirrored RSS enclosure, a room recording. */
  | { kind: 'application' }
  /** A person's: a locker file, a hosted show's episode. */
  | { kind: 'account'; oxyUserId: string };

/** An audio file Syra stored in, or imported into, Oxy. */
export interface StoredOxyAudio {
  fileId: string;
  sha256: string;
  size: number;
  mime: string;
  deduplicated: boolean;
}

/**
 * The largest original sent in ONE request (`uploadAppFile`/`uploadUserMedia`);
 * a larger one goes by Oxy's resumable multipart upload.
 */
export const SINGLE_REQUEST_MAX_BYTES = 40 * 1024 * 1024;

/** Every play session lasts at least this long, and at least the media's length. */
export const MIN_PLAY_SESSION_SECONDS = 3600;
/** Oxy's ceiling on a play session (12 h). */
export const MAX_PLAY_SESSION_SECONDS = 43_200;

/** The MIME type of an original in one of Syra's stored formats. */
export function audioMimeFor(format: string): string {
  switch (format.toLowerCase()) {
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
    case 'aac':
      return 'audio/mp4';
    case 'ogg':
      return 'audio/ogg';
    case 'opus':
      return 'audio/opus';
    case 'wav':
      return 'audio/wav';
    case 'flac':
      return 'audio/flac';
    default:
      return `audio/${format.toLowerCase()}`;
  }
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** The HTTP status and machine code of an SDK error (`OxyApiError`), when it has them. */
export function oxyErrorOf(error: unknown): { status: number; code: string } {
  if (error && typeof error === 'object') {
    const status = (error as { status?: unknown }).status;
    const code = (error as { code?: unknown }).code;
    return {
      status: typeof status === 'number' ? status : 0,
      code: typeof code === 'string' ? code : '',
    };
  }
  return { status: 0, code: '' };
}

// ── Hashing ──────────────────────────────────────────────────────────────────

/** SHA-256 of a local file, streamed (an original may be gigabytes). */
export function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ── Bookkeeping ──────────────────────────────────────────────────────────────

async function rememberAudioFile(stored: StoredOxyAudio, owner: AudioOwner): Promise<void> {
  await getDb()
    .insert(oxyAudioFiles)
    .values({
      fileId: stored.fileId,
      ownerKind: owner.kind,
      ownerOxyUserId: owner.kind === 'account' ? owner.oxyUserId : null,
      sha256: stored.sha256,
      mime: stored.mime,
      sizeBytes: stored.size,
    })
    .onConflictDoUpdate({
      target: oxyAudioFiles.fileId,
      set: {
        sha256: stored.sha256,
        mime: stored.mime,
        sizeBytes: stored.size,
        updatedAt: sql`date_trunc('milliseconds', now())`,
      },
    });
}

/**
 * Point a row at its Oxy audio file. The column's trigger queues the reference
 * (`0036`), in this same statement's transaction.
 */
export async function attachAudioFile(entity: AudioEntity, fileId: string | null): Promise<void> {
  const db = getDb();
  switch (entity.kind) {
    case 'track':
      await db.update(tracks).set({ audioFileId: fileId }).where(eq(tracks.id, entity.id));
      return;
    case 'user_upload':
      await db
        .update(userUploads)
        .set({ audioFileId: fileId })
        .where(eq(userUploads.id, entity.id));
      return;
    case 'episode':
      await db.update(episodes).set({ audioFileId: fileId }).where(eq(episodes.id, entity.id));
      return;
    case 'recording':
      await db.update(recordings).set({ oxyFileId: fileId }).where(eq(recordings.id, entity.id));
      return;
  }
}

/** What Syra knows about an Oxy audio file, or `null` for a file it never stored. */
export async function audioFileState(
  fileId: string,
): Promise<{ status: OxyAudioFileStatus; hlsReadyAt: Date | null } | null> {
  const [row] = await getDb()
    .select({ status: oxyAudioFiles.status, hlsReadyAt: oxyAudioFiles.hlsReadyAt })
    .from(oxyAudioFiles)
    .where(eq(oxyAudioFiles.fileId, fileId))
    .limit(1);
  return row ?? null;
}

/** Record what an Oxy file event says about an audio file; `0` when it is not one of Syra's. */
export async function setAudioFileStatus(
  fileId: string,
  status: OxyAudioFileStatus,
): Promise<number> {
  const rows = await getDb()
    .update(oxyAudioFiles)
    .set({ status, updatedAt: sql`date_trunc('milliseconds', now())` })
    .where(eq(oxyAudioFiles.fileId, fileId))
    .returning({ fileId: oxyAudioFiles.fileId });
  return rows.length;
}

async function markLadderReady(fileId: string): Promise<void> {
  await getDb()
    .update(oxyAudioFiles)
    .set({ hlsReadyAt: sql`coalesce(${oxyAudioFiles.hlsReadyAt}, now())` })
    .where(eq(oxyAudioFiles.fileId, fileId));
}

// ── Storing ──────────────────────────────────────────────────────────────────

export interface StoreAudioInput {
  entity: AudioEntity;
  /** The original, on local disk. */
  localPath: string;
  mime: string;
  owner: AudioOwner;
  /** The original's name, for the person's file manager. */
  filename?: string;
  /** Where Oxy's 30-second preview starts (Syra's default clip starts at 0). */
  previewStartSeconds?: number;
  /** The original's SHA-256 when the caller already measured it. */
  sha256?: string;
}

/**
 * Store an original as a PRIVATE Oxy audio file, verify it, and point the row
 * at it. Throws on any refusal — callers that must not fail use
 * {@link mirrorAudioToOxy}.
 */
export async function storeAudioInOxy(input: StoreAudioInput): Promise<StoredOxyAudio> {
  const size = statSync(input.localPath).size;
  const sha256 = input.sha256 ?? (await sha256OfFile(input.localPath));
  const entityType = AUDIO_REFERENCE_ENTITY_TYPES[input.entity.kind];
  const audio = { previewStartSeconds: input.previewStartSeconds ?? 0 };
  const api = oxyFiles();

  let stored: StoredOxyAudio;
  if (size <= SINGLE_REQUEST_MAX_BYTES) {
    const bytes = await readFile(input.localPath);
    if (input.owner.kind === 'application') {
      const { file, deduplicated } = await api.uploadAppFile(bytes, input.mime, {
        visibility: 'private',
        audio,
        ...(input.filename ? { originalName: input.filename } : {}),
      });
      stored = {
        fileId: file.id,
        sha256: file.sha256,
        size: file.size,
        mime: file.mime,
        deduplicated,
      };
    } else {
      const file = await api.uploadUserMedia(input.owner.oxyUserId, bytes, input.mime, {
        visibility: 'private',
        audio,
        ...(input.filename ? { originalName: input.filename } : {}),
      });
      stored = {
        fileId: file.id,
        sha256: file.sha256,
        size: file.size,
        mime: file.mime,
        deduplicated: false,
      };
    }
  } else {
    const options = {
      mime: input.mime,
      sha256,
      audio,
      reference: { entityType, entityId: input.entity.id },
      ...(input.filename ? { filename: input.filename } : {}),
    };
    const result =
      input.owner.kind === 'application'
        ? await api.uploadAppFileLarge(input.localPath, { ...options, visibility: 'private' })
        : await api.uploadUserMediaLarge(input.owner.oxyUserId, input.localPath, {
            ...options,
            visibility: 'private',
          });
    stored = {
      fileId: result.file.id,
      sha256: result.file.sha256,
      size: result.file.size,
      mime: result.file.mime,
      deduplicated: result.deduplicated,
    };
  }

  if (stored.sha256 !== sha256) {
    throw new Error(
      `Oxy stored ${stored.fileId} with SHA-256 ${stored.sha256}, not the ${sha256} Syra sent`,
    );
  }
  await rememberAudioFile(stored, input.owner);
  await attachAudioFile(input.entity, stored.fileId);
  return stored;
}

/**
 * {@link storeAudioInOxy} when `OXY_AUDIO` allows it, never throwing: `null`
 * means "not in Oxy" — the mode is `legacy`, or Oxy refused or could not be
 * reached — and the caller keeps (or builds) its legacy copy.
 */
export async function mirrorAudioToOxy(input: StoreAudioInput): Promise<StoredOxyAudio | null> {
  if (!oxyAudioEnabled()) return null;
  try {
    return await storeAudioInOxy(input);
  } catch (error) {
    logger.warn('[OxyAudio] audio not stored in Oxy; the legacy path keeps it', {
      entity: input.entity,
      ...oxyErrorOf(error),
      error: describeErrorSafely(error),
    });
    return null;
  }
}

/**
 * Import a podcast enclosure INTO Oxy, as Syra's own private file, and point the
 * episode at it. Oxy fetches the URL (https, public hosts, at most 8 GiB; one
 * over 40 MiB in the background — the SDK waits for it). Throws on a refusal.
 */
export async function importEnclosureToOxy(
  episodeId: string,
  sourceUrl: string,
): Promise<StoredOxyAudio> {
  const imported = await oxyFiles().importAppFile(sourceUrl, {
    visibility: 'private',
    reference: { entityType: AUDIO_REFERENCE_ENTITY_TYPES.episode, entityId: episodeId },
    audio: { previewStartSeconds: 0 },
  });
  const { file } = imported;
  if (!file.mime.startsWith('audio/')) {
    throw new Error(`Enclosure for episode ${episodeId} is ${file.mime}, not audio`);
  }
  const stored: StoredOxyAudio = {
    fileId: file.id,
    sha256: file.sha256,
    size: file.size,
    mime: file.mime,
    deduplicated: imported.deduplicated,
  };
  await rememberAudioFile(stored, { kind: 'application' });
  await attachAudioFile({ kind: 'episode', id: episodeId }, stored.fileId);
  return stored;
}

// ── Playing ──────────────────────────────────────────────────────────────────

export interface OxyPlayback {
  sessionId: string;
  masterUrl: string;
  renditions: Array<{ type: string; url: string; bandwidth: number | null }>;
  previewUrl?: string;
  waveformUrl?: string;
  expiresAt: string;
}

export type OxyPlaybackResult =
  | { ok: true; playback: OxyPlayback }
  /** Oxy has not finished the ladder: the legacy ladder (if any) plays meanwhile. */
  | { ok: false; reason: 'not_ready' }
  /** The file was trashed, deleted or taken down: nothing plays it, legacy included. */
  | { ok: false; reason: 'withdrawn' }
  /** Oxy could not open a session (unreachable, not deployed, misconfigured). */
  | { ok: false; reason: 'unavailable' };

export interface OpenPlaySessionInput {
  fileId: string;
  /** The listener — handed to the key authorization, and the handle of bulk revocation. */
  endUserId: string | null;
  /** The media's length, so a session never ends mid-play. */
  durationSec?: number | null;
}

function sessionTtlSeconds(durationSec: number | null | undefined): number {
  const wanted = Math.ceil((durationSec ?? 0) * 1.5);
  return Math.min(MAX_PLAY_SESSION_SECONDS, Math.max(MIN_PLAY_SESSION_SECONDS, wanted));
}

/**
 * Open a per-listener play session on one Oxy audio file: AES-128, the key
 * released only after Syra's file-events endpoint allows it. Never throws.
 */
export async function openPlaySession(input: OpenPlaySessionInput): Promise<OxyPlaybackResult> {
  const state = await audioFileState(input.fileId);
  if (state && state.status !== 'active') return { ok: false, reason: 'withdrawn' };

  let session: PlaySession;
  try {
    session = await oxyFiles().streams.create(input.fileId, {
      ...(input.endUserId ? { endUserId: input.endUserId } : {}),
      ttlSeconds: sessionTtlSeconds(input.durationSec),
      encryption: 'aes-128',
      keyAuthorization: 'webhook',
    });
  } catch (error) {
    const { status, code } = oxyErrorOf(error);
    if (status === 409 && code === 'STREAM_NOT_READY') return { ok: false, reason: 'not_ready' };
    logger.warn('[OxyAudio] play session not opened; the legacy path answers', {
      fileId: input.fileId,
      status,
      code,
      error: describeErrorSafely(error),
    });
    return { ok: false, reason: 'unavailable' };
  }

  if (!state?.hlsReadyAt) {
    await markLadderReady(input.fileId).catch(() => undefined);
  }
  return {
    ok: true,
    playback: {
      sessionId: session.sessionId,
      masterUrl: session.masterUrl,
      renditions: session.renditions,
      ...(session.previewUrl ? { previewUrl: session.previewUrl } : {}),
      ...(session.waveformUrl ? { waveformUrl: session.waveformUrl } : {}),
      expiresAt: session.expiresAt,
    },
  };
}

/**
 * Stop playback of a file at the next request, on every Oxy server — a
 * takedown, a deleted upload. Best-effort: Oxy also refuses the key once the
 * row stops authorizing it (`audioKeyAuthorization.ts`).
 */
export async function revokePlaySessions(filter: {
  fileId?: string;
  endUserId?: string;
}): Promise<number> {
  if (!filter.fileId && !filter.endUserId) return 0;
  try {
    const { revoked } = await oxyFiles().streams.revokeWhere(filter);
    return revoked;
  } catch (error) {
    logger.warn('[OxyAudio] play sessions not revoked', {
      ...filter,
      ...oxyErrorOf(error),
      error: describeErrorSafely(error),
    });
    return 0;
  }
}

/**
 * A short-lived direct URL to an Oxy audio file's ORIGINAL bytes — the
 * progressive path (an RSS client's enclosure, a recording's playback). `null`
 * when Oxy answered no URL for it.
 */
export async function originalDownloadUrl(fileId: string): Promise<string | null> {
  const state = await audioFileState(fileId);
  if (state && state.status !== 'active') return null;
  try {
    const [link] = await oxyFiles().linkedDownloadUrls([fileId]);
    return link?.url ?? null;
  } catch (error) {
    logger.warn('[OxyAudio] no download URL for an audio file', {
      fileId,
      ...oxyErrorOf(error),
      error: describeErrorSafely(error),
    });
    return null;
  }
}

/**
 * Whether Oxy has the audio ladder for these files, asked of Oxy itself
 * (`hlsReadyAt`) — what the backfill's verification and the legacy-ladder
 * retirement are gated on. Throws when Oxy cannot answer.
 */
export async function laddersReady(fileIds: string[]): Promise<Map<string, boolean>> {
  const ready = new Map<string, boolean>(fileIds.map((id) => [id, false]));
  if (fileIds.length === 0) return ready;
  const metadata = await oxyFiles().metadataByIds(fileIds);
  for (const file of metadata) {
    const isReady = file.status === 'active' && Boolean(file.hlsReadyAt);
    ready.set(file.id, isReady);
    if (isReady) await markLadderReady(file.id);
  }
  return ready;
}

// ── Recording ────────────────────────────────────────────────────────────────

/** Where LiveKit egress writes a room recording: an Oxy recording target. */
export async function createRecordingTarget(input: {
  recordingId: string;
  roomId: string;
  maxDurationSec: number;
}): Promise<CreatedRecordingTarget> {
  return oxyFiles().createAppRecordingTarget({
    visibility: 'private',
    filename: `${input.roomId}-${input.recordingId}.ogg`,
    reference: { entityType: AUDIO_REFERENCE_ENTITY_TYPES.recording, entityId: input.recordingId },
    // Egress uploads when the recording ENDS; a day past the longest recording.
    expiresInSeconds: Math.min(604_800, Math.ceil(input.maxDurationSec) + 86_400),
  });
}

/**
 * Collect a recording Oxy finished verifying: point the row at its file.
 * `null` while egress has not written it or Oxy is still verifying — asked
 * again on the next read; never throws.
 */
export async function collectRecording(
  recordingId: string,
  targetId: string,
): Promise<string | null> {
  try {
    const target = await oxyFiles().getRecordingTarget(targetId);
    if (target.status !== 'completed' || !target.file) return null;
    const file = target.file;
    await rememberAudioFile(
      {
        fileId: file.id,
        sha256: file.sha256,
        size: file.size,
        mime: file.mime,
        deduplicated: Boolean(target.deduplicated),
      },
      { kind: 'application' },
    );
    await attachAudioFile({ kind: 'recording', id: recordingId }, file.id);
    return file.id;
  } catch (error) {
    logger.warn('[OxyAudio] recording not collected yet', {
      recordingId,
      ...oxyErrorOf(error),
      error: describeErrorSafely(error),
    });
    return null;
  }
}
