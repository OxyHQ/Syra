import { Router, Response } from 'express';
import multer from 'multer';
import { isLiveEntityId, uuidv7 } from '@oxyhq/db';
import { requireOxyAuth, getRequiredOxyUserId, type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import {
  createRoom,
  deleteRoom,
  findLiveRoomBroadcasters,
  findPublicRoomById,
  findRoomById,
  findRoomQueue,
  listRooms,
  replaceRoomStreamAndQueue,
  stopRoomStreamFields,
  updateRoom,
  type RoomOwnershipFields,
  type RoomWithCredentials,
} from '../db/rooms/rooms';
import {
  canAccessRooms,
  canSeeHouse,
  findHouseWithMembers,
  hasRole,
  houseIdsWithRoomsHiddenFrom,
} from '../db/rooms/houses';
import {
  createRecording,
  findRecordingByEgressId,
  findRecordingById,
  findTopHosts,
  finishRecording,
  listRoomRecordings,
  updateRecording,
} from '../db/rooms/recordings';
import { findLiveVisibilities, findLiveVisibility, setLiveVisibility } from '../db/rooms/preferences';
import { stripInternalStreamFields, roomWithInternalStreamFields } from '../db/rooms/serialize';
import {
  BroadcastKind,
  DEFAULT_LIVE_VISIBILITY,
  HouseMemberRole,
  OwnerType,
  RoomStatus,
  RoomType,
  SpeakerPermission,
  isLiveVisibility,
  type LiveVisibility,
  type MediaQueueItem,
} from '../db/rooms/types';
import { describeErrorSafely } from '../utils/error';
import { getParam } from '../utils/reqParams';
import { logger } from '../utils/logger';
import {
  generateRoomToken,
  generateBroadcastToken,
  createLiveKitRoomForRoom,
  ensureLiveKitRoomForRoom,
  deleteLiveKitRoomForRoom,
  createRoomUrlIngress,
  createRoomRtmpIngress,
  deleteIngress,
  startRoomRecording,
  stopRoomRecording,
} from '../utils/livekit';
import {
  mapLiveKitIngressError,
  shouldRetryIngressAfterDeletingExisting,
} from '../utils/livekitErrors';
import { getRecordingObjectKey, uploadObject, deleteObject, getAgoraRoomImageKey, cdnUrlToKey } from '../utils/spaces';
import { processImage } from '../utils/imageProcessor';
import { emitLiveRoomsUpdated } from '../utils/socket';
import { resolvePodcastEpisode } from '../utils/syraPodcast';
import { resolveTrack, resolveAlbumTracks, resolvePlaylistTracks } from '../utils/syraMedia';
import {
  fetchUpstreamFollowingRedirects,
  contentTypeFamily,
  SsrfRejection,
} from '../utils/safeUpstreamFetch';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed. Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}`));
    }
  }
});

const router = Router();

type CreatedIngress = Awaited<ReturnType<typeof createRoomUrlIngress>>;

interface IngressReplacementResult {
  ingress: CreatedIngress;
  previousIngressId?: string;
  previousDeletedBeforeCreate: boolean;
}

/** Look a room up only when the id could name one — see `isLiveEntityId`. */
async function loadRoom(id: string): Promise<RoomWithCredentials | undefined> {
  return isLiveEntityId(id) ? findRoomById(id) : undefined;
}

/**
 * Whether `userId` may manage this room.
 *
 * Management is ownership-scoped: the room's own host, or an admin of the owning
 * house. Platform-owned (AGORA) rooms deliberately fall through to `false` — they
 * are created and operated server-side by the platform, never over HTTP, and Syra
 * has no platform-wide superuser role that could grant access here. The omission is
 * the design, not a gap to fill in later.
 *
 * It also fails closed on a house-owned room whose `houseId` is null. That state
 * is reachable now that deleting a house nulls its rooms' `house_id`
 * (`ON DELETE SET NULL`) without touching their `owner_type` — see
 * `schema/rooms.ts`, which records it as a deliberate open product question
 * rather than a bug. The `!room.houseId` branch below is what makes it safe.
 */
async function canManageRoom(room: RoomOwnershipFields, userId: string): Promise<boolean> {
  if (room.host === userId) {
    return true;
  }

  if (room.ownerType === OwnerType.HOUSE) {
    if (!room.houseId) {
      return false;
    }

    const owning = await findHouseWithMembers(room.houseId);
    return owning !== undefined && hasRole(owning.members, userId, HouseMemberRole.ADMIN);
  }

  return false;
}

async function sendForbiddenUnlessRoomManager(
  room: RoomOwnershipFields,
  userId: string,
  res: Response,
  message: string
): Promise<boolean> {
  if (await canManageRoom(room, userId)) {
    return true;
  }

  res.status(403).json({ message });
  return false;
}

function emitStreamStarted(
  roomId: string,
  room: Pick<RoomWithCredentials, 'streamTitle' | 'streamImage' | 'streamDescription' | 'streamStartedAt' | 'streamDurationSec'>,
) {
  const io = global.io;
  if (!io) return;

  const roomPayload = {
    roomId,
    title: room.streamTitle || undefined,
    image: room.streamImage || undefined,
    description: room.streamDescription || undefined,
    // Progress-card inputs: when the stream started (ISO) and its total length
    // (seconds) when known. The client can render elapsed/total from these
    // alone, without re-fetching the room.
    startedAt: room.streamStartedAt ? room.streamStartedAt.toISOString() : undefined,
    durationSec: typeof room.streamDurationSec === 'number' ? room.streamDurationSec : undefined,
    timestamp: new Date().toISOString(),
  };

  io.of('/rooms').to(`room:${roomId}`).emit('room:stream:started', roomPayload);
}

function emitStreamStopped(roomId: string) {
  const io = global.io;
  if (!io) return;

  const roomPayload = {
    roomId,
    timestamp: new Date().toISOString(),
  };

  io.of('/rooms').to(`room:${roomId}`).emit('room:stream:stopped', roomPayload);
}

function sendLiveKitIngressError(
  res: Response,
  error: unknown,
  operation: string,
  context: { roomId: string; userId?: string }
) {
  const mapped = mapLiveKitIngressError(error);
  logger.warn('LiveKit stream ingress operation failed', {
    operation,
    roomId: context.roomId,
    userId: context.userId,
    status: mapped.liveKit.status,
    code: mapped.liveKit.code,
    message: mapped.liveKit.message,
    responseCode: mapped.code,
  });

  return res.status(mapped.statusCode).json({
    message: mapped.message,
    code: mapped.code,
  });
}

async function createIngressReplacingExisting(
  room: RoomWithCredentials,
  roomId: string,
  createIngress: () => Promise<CreatedIngress>
): Promise<IngressReplacementResult> {
  const previousIngressId = room.activeIngressId || undefined;

  try {
    return {
      ingress: await createIngress(),
      previousIngressId,
      previousDeletedBeforeCreate: false,
    };
  } catch (error) {
    if (!previousIngressId || !shouldRetryIngressAfterDeletingExisting(error)) {
      throw error;
    }

    logger.warn('Retrying stream ingress creation after deleting existing ingress', {
      roomId,
      ingressId: previousIngressId,
    });
    await deleteIngress(previousIngressId);

    return {
      ingress: await createIngress(),
      previousIngressId,
      previousDeletedBeforeCreate: true,
    };
  }
}

async function cleanupPreviousIngressAfterReplacement(roomId: string, result: IngressReplacementResult) {
  if (
    result.previousIngressId &&
    !result.previousDeletedBeforeCreate &&
    result.previousIngressId !== result.ingress.ingressId
  ) {
    await deleteIngress(result.previousIngressId);
    logger.info(`Replaced previous ingress for room ${roomId}: ${result.previousIngressId}`);
  }
}

/** Metadata persisted alongside a URL ingress. `durationSec` is known only for
 * finite sources (e.g. a podcast episode); open-ended URLs omit it. */
type UrlIngressMeta = {
  url: string;
  title?: string;
  image?: string;
  description?: string;
  durationSec?: number;
};

/** Res-free result of {@link applyUrlIngressToRoom}. */
type ApplyUrlIngressOutcome =
  | { ok: true; ingressId: string; url: string; room: RoomWithCredentials }
  | { ok: false; error: unknown };

/**
 * Start (or replace) a LiveKit URL ingress for a live room and persist it —
 * the res-FREE core shared by `POST /:id/stream`, `POST /:id/stream/podcast`,
 * `POST /:id/stream/podcast/next`, and the LiveKit auto-advance webhook.
 *
 * Callers MUST perform their own auth / manager / `RoomStatus.LIVE` validation
 * and pass an already-validated `meta.url`; this owns only the ingress +
 * persistence + socket-broadcast half. `meta.title` / `meta.image` /
 * `meta.description` are stored verbatim (callers normalize); the RTMP fields
 * are CLEARED (starting a URL ingress switches the room out of RTMP mode);
 * `streamStartedAt` is stamped now and `streamDurationSec` mirrors
 * `meta.durationSec`. On a LiveKit failure it returns `{ ok: false, error }`
 * WITHOUT persisting — the caller maps the error.
 *
 * Every optional field is written as `?? null` rather than left `undefined`.
 * Drizzle DROPS an `undefined`-valued key from the update, so the Mongoose
 * spelling would leave the PREVIOUS stream's title, artwork, duration and — for
 * a room switching out of RTMP mode — its still-valid RTMP PUBLISHING KEY in
 * place. That last one is why this is stated here rather than left to the
 * update helper: the clear is a security property, not a cosmetic one.
 *
 * `queue` is the remainder to persist, written in the SAME transaction as the
 * stream fields. That is what preserves the Mongo behaviour the routes rely on:
 * a failed start never reaches here, so the persisted queue keeps its head for a
 * retry.
 */
async function applyUrlIngressToRoom(
  room: RoomWithCredentials,
  id: string,
  meta: UrlIngressMeta,
  queue: readonly MediaQueueItem[],
): Promise<ApplyUrlIngressOutcome> {
  let ingressResult: IngressReplacementResult;
  try {
    await ensureLiveKitRoomForRoom(id, room.maxParticipants);
    ingressResult = await createIngressReplacingExisting(room, id, () =>
      createRoomUrlIngress(id, meta.url)
    );
    await cleanupPreviousIngressAfterReplacement(id, ingressResult);
  } catch (liveKitError) {
    return { ok: false, error: liveKitError };
  }

  const updated = await replaceRoomStreamAndQueue(
    id,
    {
      activeIngressId: ingressResult.ingress.ingressId,
      activeStreamUrl: meta.url,
      rtmpUrl: null,
      rtmpStreamKey: null,
      streamTitle: meta.title ?? null,
      streamImage: meta.image ?? null,
      streamDescription: meta.description ?? null,
      streamStartedAt: new Date(),
      streamDurationSec: typeof meta.durationSec === 'number' ? meta.durationSec : null,
    },
    queue,
  );

  if (!updated) {
    return { ok: false, error: new Error(`Room ${id} disappeared while starting its stream`) };
  }

  logger.info(`Live stream started in room ${id}: ${meta.url}`);

  // Notify participants via socket (no URL -- only metadata)
  emitStreamStarted(id, updated);

  return { ok: true, ingressId: ingressResult.ingress.ingressId, url: meta.url, room: updated };
}

/**
 * HTTP wrapper over {@link applyUrlIngressToRoom} for the host-supplied-URL
 * route: runs the shared SSRF-guarded {@link validatePlayableAudioUrl} probe on
 * the caller-supplied URL FIRST, then starts the ingress and writes the standard
 * `{ message, ingressId, url }` response, or maps a validation / LiveKit failure
 * via {@link sendLiveKitIngressError}. This is the single validation gate for the
 * manual-URL path, mirroring the probe {@link startResolvedMediaStream} runs for
 * the resolved podcast/track paths — so no path reaches the ingress unvalidated.
 */
async function startUrlIngressForRoom(
  room: RoomWithCredentials,
  id: string,
  meta: UrlIngressMeta,
  res: Response,
  userId: string,
): Promise<void> {
  const validation = await validatePlayableAudioUrl(meta.url);
  if (!validation.ok) {
    res.status(validation.status).json({ message: validation.message });
    return;
  }

  const outcome = await applyUrlIngressToRoom(room, id, meta, []);
  if (!outcome.ok) {
    sendLiveKitIngressError(res, outcome.error, 'create-url-ingress', { roomId: id, userId });
    return;
  }

  res.json({
    message: 'Stream started successfully',
    ingressId: outcome.ingressId,
    url: outcome.url,
  });
}

/**
 * Bounded time-to-first-byte deadline for the pre-ingress audio-URL probe.
 * Kept short: this only confirms the upstream is alive and serving audio, not
 * that the whole file downloads.
 */
const AUDIO_URL_VALIDATION_TIMEOUT_MS = 6_000;

/** HLS playlist content-types a URL ingress can consume as audio. */
const HLS_PLAYLIST_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
]);

/**
 * Generic binary content-types podcast CDNs frequently serve for a direct
 * audio file instead of a precise `audio/*` label. Accepted so the safety layer
 * rejects only clearly-wrong bodies (HTML error pages, images, video) without
 * dropping legitimate episodes served as an opaque download.
 */
const OPAQUE_BINARY_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/octet-stream',
  'binary/octet-stream',
]);

function isPlayableAudioContentType(family: string): boolean {
  return (
    family.startsWith('audio/') ||
    HLS_PLAYLIST_CONTENT_TYPES.has(family) ||
    OPAQUE_BINARY_CONTENT_TYPES.has(family)
  );
}

type AudioUrlValidation = { ok: true } | { ok: false; status: 400 | 502; message: string };

/**
 * SSRF-guarded, bounded pre-ingress probe of a resolved audio URL. Confirms the
 * URL is a reachable PUBLIC http(s) endpoint (every hop re-validated by
 * {@link fetchUpstreamFollowingRedirects} / `assertSafePublicUrl`, IP-pinned to
 * close the DNS-rebind window) serving audio — so we never hand LiveKit a dead,
 * internal, or non-audio ingress URL.
 *
 * A tiny `bytes=0-1` range request keeps it bounded; only the status line +
 * headers are inspected and the body is destroyed immediately. Mapping:
 *  - blocked/malformed target, upstream 4xx, or non-audio body → `400` (the URL
 *    is invalid for our purposes);
 *  - unreachable / timeout / upstream 5xx → `502`.
 */
async function validatePlayableAudioUrl(url: string): Promise<AudioUrlValidation> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUDIO_URL_VALIDATION_TIMEOUT_MS);
  try {
    const { response } = await fetchUpstreamFollowingRedirects(
      url,
      { range: 'bytes=0-1' },
      controller.signal,
    );
    const status = response.statusCode ?? 0;
    const family = contentTypeFamily(response.headers);
    // Only the status line + headers are needed; never drain the media body.
    response.destroy();

    if (status >= 400 && status < 500) {
      return { ok: false, status: 400, message: 'Podcast episode audio is not available' };
    }
    if (status < 200 || status >= 300) {
      return { ok: false, status: 502, message: 'Podcast episode audio is temporarily unreachable' };
    }
    if (!isPlayableAudioContentType(family)) {
      return { ok: false, status: 400, message: 'Resolved URL is not playable audio' };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof SsrfRejection) {
      logger.warn('Rejected non-public podcast audio URL', { reason: err.message });
      return { ok: false, status: 400, message: 'Podcast episode audio URL is not allowed' };
    }
    logger.warn('Podcast audio URL unreachable', {
      reason: err instanceof Error ? err.message : 'unknown',
    });
    return { ok: false, status: 502, message: 'Podcast episode audio is temporarily unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Res-free outcome shape shared by every media (podcast/track) stream-start path. */
type MediaStreamOutcome =
  | { ok: true; ingressId: string; url: string }
  | { ok: false; status: number; body: { message: string; code?: string } };

/**
 * Feed an already-resolved, server-owned audio URL + card metadata through the
 * shared SSRF-guarded probe → LiveKit URL ingress. The res-free tail shared by
 * both the podcast-episode and music-track pipelines so they enforce the
 * identical safety policy.
 *
 * Failure mapping: non-audio/blocked URL → 400, unreachable upstream → 502,
 * LiveKit ingress failure → the mapped LiveKit status.
 */
async function startResolvedMediaStream(
  room: RoomWithCredentials,
  id: string,
  meta: UrlIngressMeta,
  queue: readonly MediaQueueItem[],
  userId: string,
  operation: string,
): Promise<MediaStreamOutcome> {
  const validation = await validatePlayableAudioUrl(meta.url);
  if (!validation.ok) {
    return { ok: false, status: validation.status, body: { message: validation.message } };
  }

  const outcome = await applyUrlIngressToRoom(room, id, meta, queue);
  if (!outcome.ok) {
    const mapped = mapLiveKitIngressError(outcome.error);
    logger.warn('LiveKit stream ingress operation failed', {
      operation,
      roomId: id,
      userId,
      status: mapped.liveKit.status,
      code: mapped.liveKit.code,
      message: mapped.liveKit.message,
    });
    return { ok: false, status: mapped.statusCode, body: { message: mapped.message, code: mapped.code } };
  }

  return { ok: true, ingressId: outcome.ingressId, url: outcome.url };
}

/**
 * The full server-side podcast-episode → live-stream pipeline (res-free):
 * tri-state resolve → SSRF-guarded audio probe → URL ingress. Shared by the
 * `POST /:id/stream/podcast` route, the `/next` manual-advance route, and the
 * LiveKit auto-advance webhook so all enforce the identical policy.
 *
 * Failure mapping: `not_found` → 404, `unavailable` → 503, then the shared
 * probe/ingress mapping. `queue` is the post-start remainder, persisted
 * atomically with the ingress fields only on success.
 */
async function startPodcastEpisodeStream(
  room: RoomWithCredentials,
  id: string,
  episodeId: string,
  expectedPodcastId: string | undefined,
  queue: readonly MediaQueueItem[],
  userId: string,
): Promise<MediaStreamOutcome> {
  const resolved = await resolvePodcastEpisode(episodeId, expectedPodcastId);
  if (resolved.status === 'not_found') {
    return { ok: false, status: 404, body: { message: 'Podcast episode not found' } };
  }
  if (resolved.status === 'unavailable') {
    return { ok: false, status: 503, body: { message: 'Podcast service is temporarily unavailable' } };
  }

  return startResolvedMediaStream(
    room,
    id,
    {
      url: resolved.episode.audioUrl,
      title: resolved.episode.title,
      image: resolved.episode.artworkUrl,
      description: undefined,
      durationSec: resolved.episode.durationSec,
    },
    queue,
    userId,
    'create-podcast-ingress',
  );
}

/**
 * The full server-side track → live-stream pipeline (res-free): tri-state resolve
 * → SSRF-guarded audio probe → URL ingress. The music-shaped sibling of
 * {@link startPodcastEpisodeStream}, shared by `POST /:id/stream/track` and the
 * mixed-queue advance paths. The audio URL is resolved server-side from Syra's
 * catalog ({@link resolveTrack}) — the client only ever supplies the track id.
 *
 * Failure mapping: `not_found` → 404, `unavailable` → 503, then the shared
 * probe/ingress mapping.
 */
async function startTrackStream(
  room: RoomWithCredentials,
  id: string,
  trackId: string,
  queue: readonly MediaQueueItem[],
  userId: string,
): Promise<MediaStreamOutcome> {
  const resolved = await resolveTrack(trackId);
  if (resolved.status === 'not_found') {
    return { ok: false, status: 404, body: { message: 'Track not found' } };
  }
  if (resolved.status === 'unavailable') {
    return { ok: false, status: 503, body: { message: 'Track audio is temporarily unavailable' } };
  }

  return startResolvedMediaStream(
    room,
    id,
    {
      url: resolved.track.audioUrl,
      title: resolved.track.title,
      image: resolved.track.artworkUrl,
      description: resolved.track.artist,
      durationSec: resolved.track.durationSec,
    },
    queue,
    userId,
    'create-track-ingress',
  );
}

/**
 * Resolve + start a single mixed-queue item (podcast episode OR music track) by
 * its `kind`. The one dispatch point shared by the manual `/next` advance and
 * the LiveKit auto-advance webhook, so both handle a queue of either kind.
 */
async function startMediaQueueItem(
  room: RoomWithCredentials,
  id: string,
  item: MediaQueueItem,
  queue: readonly MediaQueueItem[],
  userId: string,
): Promise<MediaStreamOutcome> {
  if (item.kind === 'track') {
    if (!item.trackId) {
      return { ok: false, status: 404, body: { message: 'Queued track is missing its id' } };
    }
    return startTrackStream(room, id, item.trackId, queue, userId);
  }
  if (!item.episodeId) {
    return { ok: false, status: 404, body: { message: 'Queued episode is missing its id' } };
  }
  return startPodcastEpisodeStream(room, id, item.episodeId, item.syraPodcastId, queue, userId);
}

/** Upper bound on media items queued behind the current one (DoS / abuse guard). */
const MAX_MEDIA_QUEUE_LENGTH = 100;

type ParsedMediaQueue =
  | { ok: true; queue: MediaQueueItem[] }
  | { ok: false; message: string };

/**
 * Validate + normalize an optional client-supplied podcast queue into
 * {@link MediaQueueItem} rows (`kind: 'podcast'`). Each item must carry a
 * non-empty `episodeId`; `syraPodcastId` is optional (used for the show
 * cross-check at play-time). Absent/null ⇒ an empty queue. The playable audio
 * URL is never accepted from the client — only opaque ids.
 */
function parsePodcastQueue(input: unknown): ParsedMediaQueue {
  if (input === undefined || input === null) {
    return { ok: true, queue: [] };
  }
  if (!Array.isArray(input)) {
    return { ok: false, message: 'queue must be an array' };
  }
  if (input.length > MAX_MEDIA_QUEUE_LENGTH) {
    return { ok: false, message: `queue cannot exceed ${MAX_MEDIA_QUEUE_LENGTH} episodes` };
  }

  const queue: MediaQueueItem[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      return { ok: false, message: 'each queue item must be an object' };
    }
    const obj = item as Record<string, unknown>;
    const episodeId = typeof obj.episodeId === 'string' ? obj.episodeId.trim() : '';
    if (!episodeId) {
      return { ok: false, message: 'each queue item requires an episodeId' };
    }
    const syraPodcastId =
      typeof obj.syraPodcastId === 'string' && obj.syraPodcastId.trim() ? obj.syraPodcastId.trim() : undefined;
    queue.push({ kind: 'podcast', episodeId, ...(syraPodcastId ? { syraPodcastId } : {}) });
  }
  return { ok: true, queue };
}

/**
 * Validate + normalize an optional client-supplied track queue into
 * {@link MediaQueueItem} rows (`kind: 'track'`). Each item must carry a non-empty
 * `trackId`; absent/null ⇒ an empty queue. Only opaque ids are accepted — the
 * playable audio URL is always resolved server-side at play-time.
 */
function parseTrackQueue(input: unknown): ParsedMediaQueue {
  if (input === undefined || input === null) {
    return { ok: true, queue: [] };
  }
  if (!Array.isArray(input)) {
    return { ok: false, message: 'queue must be an array' };
  }
  if (input.length > MAX_MEDIA_QUEUE_LENGTH) {
    return { ok: false, message: `queue cannot exceed ${MAX_MEDIA_QUEUE_LENGTH} tracks` };
  }

  const queue: MediaQueueItem[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      return { ok: false, message: 'each queue item must be an object' };
    }
    const trackId = typeof (item as Record<string, unknown>).trackId === 'string'
      ? String((item as Record<string, unknown>).trackId).trim()
      : '';
    if (!trackId) {
      return { ok: false, message: 'each queue item requires a trackId' };
    }
    queue.push({ kind: 'track', trackId });
  }
  return { ok: true, queue };
}

/**
 * Stop the room's current stream (res-free): delete the active ingress, clear
 * every stream field AND drain the queue in one transaction, and broadcast
 * `room:stream:stopped`. Safe to call when nothing is streaming — the ingress
 * delete is skipped and the clears are no-ops.
 */
async function stopRoomStream(room: RoomWithCredentials, id: string): Promise<void> {
  if (room.activeIngressId) {
    await deleteIngress(room.activeIngressId);
  }
  await stopRoomStreamFields(id);
  logger.info(`Live stream stopped in room ${id}`);
  emitStreamStopped(id);
}

/** Res-free result of {@link advancePodcastQueueForRoom}. */
export type AdvancePodcastResult =
  | { kind: 'ended' }
  | { kind: 'started'; ingressId: string; url: string }
  | { kind: 'error'; status: number; body: { message: string; code?: string } };

/**
 * Advance a room to the next queued media item, or stop the stream when the
 * queue is empty. Shared by `POST /:id/stream/podcast/next` (manual) and the
 * LiveKit `ingress_ended` webhook (auto-advance). The queue is a generic media
 * queue: each item is resolved by its `kind` — a podcast episode OR a music
 * track — so a mixed queue advances correctly.
 *
 * Reads the queue from `room_media_queue_items`, pops the head, and hands the
 * REMAINDER down to be persisted atomically with the ingress fields only on a
 * SUCCESSFUL start — so a failed start leaves the persisted queue untouched,
 * keeping the head for a retry. When the queue is empty it stops the stream via
 * {@link stopRoomStream}.
 */
export async function advancePodcastQueueForRoom(
  room: RoomWithCredentials,
  id: string,
  userId: string,
): Promise<AdvancePodcastResult> {
  const queue = await findRoomQueue(id);

  const head = queue.shift();
  if (!head) {
    await stopRoomStream(room, id);
    return { kind: 'ended' };
  }

  const outcome = await startMediaQueueItem(room, id, head, queue, userId);
  if (!outcome.ok) {
    return { kind: 'error', status: outcome.status, body: outcome.body };
  }
  return { kind: 'started', ingressId: outcome.ingressId, url: outcome.url };
}

// --- Recording auto-stop timers (1 hour max) ---
const MAX_RECORDING_DURATION_MS = 60 * 60 * 1000; // 1 hour
const RECORDING_EXPIRY_MS = 6 * 30 * 24 * 60 * 60 * 1000; // ~6 months

const recordingTimers = new Map<string, NodeJS.Timeout>();

function scheduleRecordingAutoStop(roomId: string, egressId: string, recordingId: string) {
  clearRecordingAutoStop(roomId);

  const timer = setTimeout(async () => {
    try {
      await stopRoomRecording(egressId);

      const recording = await findRecordingById(recordingId);
      if (recording) {
        const stoppedAt = new Date();
        // The `status = 'recording'` guard lives in `finishRecording`'s WHERE
        // clause, so the manual stop and this timer cannot both finish the same
        // row; it returns undefined for the loser.
        await finishRecording(
          recordingId,
          stoppedAt,
          stoppedAt.getTime() - recording.startedAt.getTime(),
          undefined,
        );
      }

      await updateRoom(roomId, { recordingEgressId: null });

      const io = global.io;
      if (io) {
        io.of('/rooms').to(`room:${roomId}`).emit('room:recording:stopped', {
          roomId,
          recordingId,
          reason: 'max_duration',
          timestamp: new Date().toISOString(),
        });
      }

      logger.info(`Recording auto-stopped after 1 hour for room ${roomId}`);
    } catch (error) {
      logger.error(`Failed to auto-stop recording for room ${roomId}:`, { error: describeErrorSafely(error) });
    } finally {
      recordingTimers.delete(roomId);
    }
  }, MAX_RECORDING_DURATION_MS);

  recordingTimers.set(roomId, timer);
}

function clearRecordingAutoStop(roomId: string) {
  const timer = recordingTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    recordingTimers.delete(roomId);
  }
}

/**
 * Helper: start recording for a room and return the Recording row.
 *
 * The Mongo version inserted a placeholder row (`egressId: 'pending'`,
 * `objectKey: 'pending'`) purely to mint an `_id` for the object key, then saved
 * twice more. The id is minted by the application here (`generatedId()` is a
 * `$defaultFn`, not a database default), so the object key is derived BEFORE the
 * insert and the row is written once, already correct. `egressId` also carries a
 * UNIQUE constraint now, which the `'pending'` sentinel would have collided on
 * the moment two rooms started recording at the same time.
 */
async function startRecordingForRoom(room: RoomWithCredentials) {
  const recordingId = uuidv7();
  const objectKey = getRecordingObjectKey(room.id, recordingId);

  const egressId = await startRoomRecording(room.id, objectKey);

  const recording = await createRecording({
    id: recordingId,
    roomId: room.id,
    roomTitle: room.title,
    host: room.host,
    egressId,
    objectKey,
    startedAt: new Date(),
    expiresAt: new Date(Date.now() + RECORDING_EXPIRY_MS),
  });

  await updateRoom(room.id, { recordingEgressId: egressId });

  scheduleRecordingAutoStop(room.id, egressId, recording.id);

  return recording;
}

/**
 * Helper: stop recording for a room. Non-fatal, and returns nothing.
 *
 * It CLEARS `recordingEgressId` with its own UPDATE rather than leaving the
 * caller to persist it. The Mongo version set `room.recordingEgressId =
 * undefined` in memory and relied on the caller's later `save()` to carry it —
 * exactly the shape that becomes a silent no-op under drizzle, so the write had
 * to move in here.
 *
 * That does mean `/end` and `/stop` now issue two room writes where Mongo issued
 * one, and a row is briefly observable with `recording_egress_id = NULL` while
 * `status` is still `live`. That intermediate is unavoidable (the alternative is
 * the no-op above) and harmless: the two writes touch disjoint columns, the
 * second never re-sends `recordingEgressId`, and `POST /:id/recording/stop`
 * produces the identical state deliberately.
 */
async function stopRecordingForRoom(room: RoomWithCredentials, reason: string = 'room_ended') {
  if (!room.recordingEgressId) return;

  const egressId = room.recordingEgressId;
  try {
    await stopRoomRecording(egressId);
  } catch (err) {
    logger.warn(`Failed to stop egress ${egressId}, may have already stopped:`, { err: describeErrorSafely(err) });
  }

  const recording = await findRecordingByEgressId(egressId);
  if (recording) {
    const stoppedAt = new Date();
    await finishRecording(
      recording.id,
      stoppedAt,
      stoppedAt.getTime() - recording.startedAt.getTime(),
      room.participants,
    );
  }

  clearRecordingAutoStop(room.id);
  await updateRoom(room.id, { recordingEgressId: null });

  const io = global.io;
  if (io) {
    io.of('/rooms').to(`room:${room.id}`).emit('room:recording:stopped', {
      roomId: room.id,
      recordingId: recording ? recording.id : undefined,
      reason,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Create a room
 * POST /api/rooms
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const {
      title,
      description,
      scheduledStart,
      maxParticipants,
      topic,
      tags,
      speakerPermission,
      type,
      ownerType,
      broadcastKind,
      houseId,
      recordingEnabled,
    } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ message: 'Title is required' });
    }

    // Validate type
    const roomType: RoomType = type && Object.values(RoomType).includes(type)
      ? type
      : RoomType.TALK;

    // Validate ownerType
    const roomOwnerType: OwnerType = ownerType && Object.values(OwnerType).includes(ownerType)
      ? ownerType
      : OwnerType.PROFILE;

    // Platform-owned rooms are provisioned server-side, not through this endpoint.
    if (roomOwnerType === OwnerType.AGORA) {
      return res.status(403).json({ message: 'Agora-owned rooms are created server-side by the platform, not through this endpoint' });
    }

    // Validate house ownership permission
    if (roomOwnerType === OwnerType.HOUSE) {
      if (!houseId || typeof houseId !== 'string') {
        return res.status(400).json({ message: 'houseId is required when ownerType is house' });
      }

      const owning = isLiveEntityId(houseId) ? await findHouseWithMembers(houseId) : undefined;
      if (!owning) {
        return res.status(404).json({ message: 'House not found' });
      }

      // User must have HOST role or higher in the house
      if (!hasRole(owning.members, userId, HouseMemberRole.HOST)) {
        return res.status(403).json({ message: 'You must be a host or higher in this house to create rooms' });
      }
    }

    // Validate scheduledStart if provided
    let scheduledStartDate: Date | undefined;
    if (scheduledStart) {
      scheduledStartDate = new Date(scheduledStart);
      if (isNaN(scheduledStartDate.getTime())) {
        return res.status(400).json({ message: 'Invalid scheduledStart date' });
      }
    }

    // For broadcast rooms, speakers array should only contain the host
    // and speakerPermission is always 'invited'
    const isBroadcast = roomType === RoomType.BROADCAST;

    const roomSpeakerPermission = isBroadcast
      ? SpeakerPermission.INVITED
      : (speakerPermission && Object.values(SpeakerPermission).includes(speakerPermission)
        ? speakerPermission
        : SpeakerPermission.INVITED);

    // Resolve broadcastKind for broadcast rooms. `null` for a non-broadcast room
    // rather than `undefined`: `rooms_broadcast_kind_requires_type_check`
    // enforces that pairing, which is the constraint the Mongoose
    // `pre('validate')` hook only ever asserted in application code.
    const resolvedBroadcastKind = isBroadcast
      ? (broadcastKind && Object.values(BroadcastKind).includes(broadcastKind)
        ? (broadcastKind as BroadcastKind)
        : BroadcastKind.USER)
      : null;

    const room = await createRoom({
      title: title.trim(),
      description: description ? String(description).trim() : null,
      host: userId,
      type: roomType,
      ownerType: roomOwnerType,
      broadcastKind: resolvedBroadcastKind,
      houseId: roomOwnerType === OwnerType.HOUSE ? houseId : null,
      status: RoomStatus.SCHEDULED,
      participants: [],
      speakers: [userId], // Host is automatically a speaker
      maxParticipants: maxParticipants && typeof maxParticipants === 'number'
        ? Math.min(Math.max(maxParticipants, 1), 10000)
        : 100,
      scheduledStart: scheduledStartDate ?? null,
      topic: topic ? String(topic).trim() : null,
      tags: Array.isArray(tags) ? tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [],
      speakerPermission: roomSpeakerPermission,
      recordingEnabled: recordingEnabled !== false, // default true
    });

    logger.info(`Room created: ${room.id} by ${userId} (type=${roomType}, ownerType=${roomOwnerType})`);

    res.status(201).json({
      message: 'Room created successfully',
      room: stripInternalStreamFields(room),
    });
  } catch (error) {
    logger.error('Error creating room:', { userId: req.user?.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error creating room',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * List active/scheduled rooms
 * GET /api/rooms
 * Query params: status, host, type, ownerType, houseId, limit, cursor
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, host, type, ownerType, houseId, limit = '20', cursor } = req.query;

    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 100);

    // Withhold rooms owned by a house this caller may not see into. Without
    // this the global listing hands out titles, hosts and participant ids that
    // `GET /api/houses/:id/rooms` refuses for the very same rooms — and since
    // `?houseId=` is honoured too, it also made this route an exact bypass of
    // that refusal.
    const hiddenHouseIds = await houseIdsWithRoomsHiddenFrom(req.user?.id);

    const rooms = await listRooms({
      status:
        typeof status === 'string' && Object.values(RoomStatus).includes(status as RoomStatus)
          ? (status as RoomStatus)
          : undefined,
      host: typeof host === 'string' ? host : undefined,
      type:
        typeof type === 'string' && Object.values(RoomType).includes(type as RoomType)
          ? (type as RoomType)
          : undefined,
      ownerType:
        typeof ownerType === 'string' && Object.values(OwnerType).includes(ownerType as OwnerType)
          ? (ownerType as OwnerType)
          : undefined,
      houseId: typeof houseId === 'string' ? houseId : undefined,
      excludeHouseIds: hiddenHouseIds,
      cursor: typeof cursor === 'string' ? cursor : undefined,
      limit: limitNum + 1,
    });

    // Check if there are more results
    const hasMore = rooms.length > limitNum;
    const roomsToReturn = hasMore ? rooms.slice(0, limitNum) : rooms;
    const nextCursor = hasMore && roomsToReturn.length > 0
      ? roomsToReturn[roomsToReturn.length - 1].id
      : undefined;

    res.json({
      rooms: roomsToReturn.map((room) => stripInternalStreamFields(room)),
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logger.error('Error fetching rooms:', { userId: req.user?.id, error: describeErrorSafely(error), query: req.query });
    res.status(500).json({
      message: 'Error fetching rooms',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Get top hosts by total listeners across recordings
 * GET /api/rooms/top-hosts
 * Query params: limit (default 10, max 20)
 */
router.get('/top-hosts', async (req: AuthRequest, res: Response) => {
  try {
    const { limit = '10' } = req.query;
    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 10, 1), 20);

    res.json({ hosts: await findTopHosts(limitNum) });
  } catch (error) {
    logger.error('Error fetching top hosts:', { userId: req.user?.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error fetching top hosts',
      error: describeErrorSafely(error),
    });
  }
});

// ---------------------------------------------------------------------------
// Live presence
// ---------------------------------------------------------------------------

/** One live-badge entry: this user is broadcasting in this live room. */
export type LiveUserEntry = { userId: string; roomId: string };

/** The minimal live-room shape {@link selectLiveUsers} needs. */
type LiveRoomBroadcasters = { id: string; host: string; speakers?: readonly string[] };

/**
 * Pure core of `GET /rooms/live-users`: from the set of currently-live rooms and
 * each candidate's visibility preference, produce the `(userId, roomId)`
 * live-badge entries.
 *
 * The "broadcasting" users of a room are its `host` ∪ `speakers` — plain
 * listeners (who live only in `participants`) are NEVER surfaced. Each broadcaster
 * is then filtered by their preference:
 *  - `active`   — surfaced whenever they broadcast in a live room (host or speaker).
 *  - `speaking` — surfaced only while an active speaker. The cheap signal is
 *    membership in the room's persisted `speakers` list; we intentionally do NOT
 *    fan out a per-room Redis `HGETALL` of live/unmuted state across every live
 *    room. The host is a speaker by construction, so a host who chose `speaking`
 *    still surfaces while their room is live.
 *
 * Yields at most one entry per (userId, roomId); a user broadcasting in multiple
 * live rooms yields one entry per room.
 */
export function selectLiveUsers(
  rooms: ReadonlyArray<LiveRoomBroadcasters>,
  visibilityByUserId: ReadonlyMap<string, LiveVisibility>,
): LiveUserEntry[] {
  const entries: LiveUserEntry[] = [];

  for (const room of rooms) {
    const roomId = String(room.id);
    const speakers = Array.isArray(room.speakers) ? room.speakers : [];
    const speakerSet = new Set<string>(speakers);
    // host ∪ speakers, deduped — the room's broadcasters.
    const broadcasters = new Set<string>([room.host, ...speakers]);

    for (const userId of broadcasters) {
      if (!userId) continue;
      const visibility = visibilityByUserId.get(userId) ?? DEFAULT_LIVE_VISIBILITY;
      if (visibility === 'speaking' && !speakerSet.has(userId)) {
        continue;
      }
      entries.push({ userId, roomId });
    }
  }

  return entries;
}

/**
 * List the users currently broadcasting in a live room, so apps can render a
 * "live" badge on their avatar. Public (optional auth); the result is not
 * viewer-specific.
 * GET /api/rooms/live-users
 * → { liveUsers: { userId: string; roomId: string }[] }
 *
 * `findLiveRoomBroadcasters` also filters `archived = false`, which Mongo did
 * NOT — see its doc comment: an archived room is the moderation restriction for
 * a room and is routinely live at the same time, so the old query kept emitting
 * a live badge for a room a moderator had restricted.
 */
router.get('/live-users', async (_req: AuthRequest, res: Response) => {
  try {
    const rooms = await findLiveRoomBroadcasters();

    // Collect every broadcaster (host + speakers) across all live rooms, then
    // resolve their preferences in a SINGLE batched query (default → active).
    const candidateIds = new Set<string>();
    for (const room of rooms) {
      if (room.host) candidateIds.add(room.host);
      for (const speaker of room.speakers ?? []) {
        if (speaker) candidateIds.add(speaker);
      }
    }

    const visibilityByUserId = await findLiveVisibilities(Array.from(candidateIds));

    res.json({ liveUsers: selectLiveUsers(rooms, visibilityByUserId) });
  } catch (error) {
    logger.error('Error fetching live users:', { error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error fetching live users',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Get the current user's live-presence preference.
 * GET /api/rooms/me/presence-preference
 * → { liveVisibility: 'active' | 'speaking' } (default 'active' if never set)
 */
router.get('/me/presence-preference', requireOxyAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = getRequiredOxyUserId(req);
    res.json({ liveVisibility: await findLiveVisibility(userId) });
  } catch (error) {
    logger.error('Error fetching presence preference:', { userId: req.user?.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error fetching presence preference',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Set the current user's live-presence preference (upsert).
 * PUT /api/rooms/me/presence-preference
 * Body: { liveVisibility: 'active' | 'speaking' }
 * → { liveVisibility: 'active' | 'speaking' }
 */
router.put('/me/presence-preference', requireOxyAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = getRequiredOxyUserId(req);
    const { liveVisibility } = (req.body ?? {}) as { liveVisibility?: unknown };

    if (!isLiveVisibility(liveVisibility)) {
      return res.status(400).json({ message: "liveVisibility must be 'active' or 'speaking'" });
    }

    res.json({ liveVisibility: await setLiveVisibility(userId, liveVisibility) });
  } catch (error) {
    logger.error('Error updating presence preference:', { userId: req.user?.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error updating presence preference',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Get room details
 * GET /api/rooms/:id
 */
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = getParam(req, 'id');

    const room = await loadRoom(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const userId = req.user?.id;

    // Fetching a house room by id is the same disclosure as listing it, so it
    // answers to the same axes — and with the same codes as
    // `GET /api/houses/:id/rooms`: 404 when the house is hidden (never confirm
    // a guessed id is real), 403 when it is merely sealed.
    if (room.houseId) {
      const owning = await findHouseWithMembers(room.houseId);
      if (!owning || !canSeeHouse(owning.house, owning.members, userId)) {
        return res.status(404).json({ message: 'Room not found' });
      }
      if (!canAccessRooms(owning.house, owning.members, userId)) {
        return res.status(403).json({ message: 'Only members can view this house\'s rooms' });
      }
    }

    const canViewInternalStreamFields = userId
      ? await canManageRoom(room, userId)
      : false;

    const queue = await findRoomQueue(room.id);

    res.json({
      room: canViewInternalStreamFields
        ? roomWithInternalStreamFields(room, queue)
        : stripInternalStreamFields(room, queue),
    });
  } catch (error) {
    logger.error('Error fetching room:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error fetching room',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Start a room (room manager only)
 * POST /api/rooms/:id/start
 */
router.post('/:id/start', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await loadRoom(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can start the room'))) {
      return;
    }

    // Can only start scheduled rooms
    if (room.status !== RoomStatus.SCHEDULED) {
      return res.status(400).json({
        message: `Cannot start room with status: ${room.status}`,
      });
    }

    // Create LiveKit room before going live
    try {
      await createLiveKitRoomForRoom(room.id, room.maxParticipants);
    } catch (lkErr) {
      logger.error(`Failed to create LiveKit room for room ${id}, starting anyway:`, lkErr);
    }

    // Update room status. For broadcast rooms, the speakers array is reset to
    // the primary host and the permission forced to `invited` in the SAME
    // update — `rooms_broadcast_speaker_permission_check` now enforces that
    // pairing, so writing them apart could be rejected in between.
    const started = await updateRoom(room.id, {
      status: RoomStatus.LIVE,
      startedAt: new Date(),
      ...(room.type === RoomType.BROADCAST
        ? { speakers: [room.host], speakerPermission: SpeakerPermission.INVITED }
        : {}),
    });

    if (!started) {
      return res.status(404).json({ message: 'Room not found' });
    }

    logger.info(`Room started: ${started.id} (type=${started.type})`);

    // Auto-start recording if enabled
    let recordingDoc = null;
    if (started.recordingEnabled) {
      try {
        recordingDoc = await startRecordingForRoom(started);
        logger.info(`Auto-started recording for room ${started.id}, egressId: ${recordingDoc.egressId}`);
      } catch (recErr) {
        logger.error(`Failed to auto-start recording for room ${started.id}:`, recErr);
        // Non-fatal: room goes live even if recording fails
      }
    }

    // Notify the room's clients that recording started (when enabled).
    const io = global.io;
    if (io && recordingDoc) {
      io.of('/rooms').to(`room:${id}`).emit('room:recording:started', {
        roomId: id,
        recordingId: recordingDoc.id,
        timestamp: new Date().toISOString(),
      });
    }

    // Signal the live-rooms widget: a room just went live.
    emitLiveRoomsUpdated('created');

    res.json({
      message: 'Room started successfully',
      room: stripInternalStreamFields(started),
    });
  } catch (error) {
    logger.error('Error starting room:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error starting room',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * End a room (room manager only)
 * POST /api/rooms/:id/end
 */
router.post('/:id/end', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await loadRoom(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can end the room'))) {
      return;
    }

    // Can only end live rooms
    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({
        message: `Cannot end room with status: ${room.status}`,
      });
    }

    // Stop active recording if any
    try {
      await stopRecordingForRoom(room, 'room_ended');
    } catch (recErr) {
      logger.error(`Error stopping recording for room ${id}:`, recErr);
    }

    // Clean up active ingress if any, then persist the end state. The stream
    // teardown and the status change are ONE update, so a room is never
    // observable as ended while its RTMP publishing key is still live.
    const lifecycle = { status: RoomStatus.ENDED, endedAt: new Date() };
    let ended;
    if (room.activeIngressId) {
      deleteIngress(room.activeIngressId).catch((err) => {
        logger.error(`Failed to delete ingress for room ${id}:`, { err: describeErrorSafely(err) });
      });
      ended = await stopRoomStreamFields(room.id, lifecycle);
    } else {
      ended = await updateRoom(room.id, lifecycle);
    }

    if (!ended) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Clean up LiveKit room
    deleteLiveKitRoomForRoom(room.id).catch((err) => {
      logger.error(`Failed to delete LiveKit room for room ${id}:`, { err: describeErrorSafely(err) });
    });

    logger.info(`Room ended: ${ended.id}`);

    // Signal the live-rooms widget: a room left the live set.
    emitLiveRoomsUpdated('ended');

    res.json({
      message: 'Room ended successfully',
      room: stripInternalStreamFields(ended),
    });
  } catch (error) {
    logger.error('Error ending room:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error ending room',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Stop a live session (room manager only) — returns room to scheduled status so it can
 * be reused.  Cleans up LiveKit room and any active ingress, but does NOT
 * permanently end the room.
 * POST /api/rooms/:id/stop
 */
router.post('/:id/stop', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await loadRoom(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can stop the room'))) {
      return;
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({
        message: `Cannot stop room with status: ${room.status}`,
      });
    }

    // Stop active recording if any
    try {
      await stopRecordingForRoom(room, 'room_stopped');
    } catch (recErr) {
      logger.error(`Error stopping recording for room ${id}:`, recErr);
    }

    // Reset to scheduled so the host can go live again later, clearing the
    // stream in the same update — see the `/end` route above.
    const lifecycle = { status: RoomStatus.SCHEDULED, startedAt: null };
    let stopped;
    if (room.activeIngressId) {
      deleteIngress(room.activeIngressId).catch((err) => {
        logger.error(`Failed to delete ingress for room ${id}:`, { err: describeErrorSafely(err) });
      });
      stopped = await stopRoomStreamFields(room.id, lifecycle);
    } else {
      stopped = await updateRoom(room.id, lifecycle);
    }

    if (!stopped) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Clean up LiveKit room
    deleteLiveKitRoomForRoom(room.id).catch((err) => {
      logger.error(`Failed to delete LiveKit room for room ${id}:`, { err: describeErrorSafely(err) });
    });

    logger.info(`Room stopped (back to scheduled): ${stopped.id}`);

    // Signal the live-rooms widget: the room left the live set (back to scheduled).
    emitLiveRoomsUpdated('ended');

    res.json({
      message: 'Live session stopped',
      room: stripInternalStreamFields(stopped),
    });
  } catch (error) {
    logger.error('Error stopping room:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error stopping room',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Join a room as listener
 * POST /api/rooms/:id/join
 */
router.post('/:id/join', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await loadRoom(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // A room in a house inherits that house's `rooms` visibility axis: entering
    // a room in a `members`-only house requires membership. The house is
    // resolved from the room's own houseId; the user comes from the session.
    if (room.houseId) {
      const owning = await findHouseWithMembers(room.houseId);
      if (owning && !canAccessRooms(owning.house, owning.members, userId)) {
        return res.status(403).json({ message: 'Only members can join this house\'s rooms' });
      }
    }

    // Can only join live rooms
    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({
        message: 'Room is not currently live',
      });
    }

    // Check if already a participant
    if (room.participants.includes(userId)) {
      return res.json({
        message: 'Already joined',
        room: stripInternalStreamFields(room),
      });
    }

    // Check capacity
    if (room.participants.length >= room.maxParticipants) {
      return res.status(403).json({
        message: 'Room is at maximum capacity',
      });
    }

    // Add to participants and update the stats. Every part is decided in SQL
    // against the current row rather than from the snapshot above, so two people
    // joining at once cannot each write back the roster they read.
    const joined = await updateRoom(room.id, {
      participants: [...room.participants, userId],
      statsTotalJoined: room.statsTotalJoined + 1,
      statsPeakListeners: Math.max(room.statsPeakListeners, room.participants.length + 1),
    });

    if (!joined) {
      return res.status(404).json({ message: 'Room not found' });
    }

    logger.debug(`User ${userId} joined room ${id}`);

    // Signal the live-rooms widget: participant count changed.
    emitLiveRoomsUpdated('participants');

    res.json({
      message: 'Joined room successfully',
      room: stripInternalStreamFields(joined),
    });
  } catch (error) {
    logger.error('Error joining room:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error joining room',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Leave a room
 * POST /api/rooms/:id/leave
 */
router.post('/:id/leave', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await loadRoom(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Remove from participants, and from speakers too (except the host)
    await updateRoom(room.id, {
      participants: room.participants.filter((p) => p !== userId),
      ...(room.speakers.includes(userId) && room.host !== userId
        ? { speakers: room.speakers.filter((s) => s !== userId) }
        : {}),
    });

    logger.debug(`User ${userId} left room ${id}`);

    // Signal the live-rooms widget only when a live room's count changed.
    if (room.status === RoomStatus.LIVE) {
      emitLiveRoomsUpdated('participants');
    }

    res.json({
      message: 'Left room successfully',
    });
  } catch (error) {
    logger.error('Error leaving room:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error leaving room',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Add speaker (room manager only)
 * POST /api/rooms/:id/speakers
 */
router.post('/:id/speakers', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');
    const { userId: speakerId } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!speakerId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const room = await loadRoom(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can add speakers'))) {
      return;
    }

    // Broadcast rooms do not allow adding speakers
    if (room.type === RoomType.BROADCAST) {
      return res.status(400).json({ message: 'Cannot add speakers to a broadcast room' });
    }

    // Check if already a speaker
    if (room.speakers.includes(speakerId)) {
      return res.json({
        message: 'User is already a speaker',
        room: stripInternalStreamFields(room),
      });
    }

    const updated = await updateRoom(room.id, { speakers: [...room.speakers, speakerId] });
    if (!updated) {
      return res.status(404).json({ message: 'Room not found' });
    }

    logger.info(`User ${speakerId} added as speaker in room ${id} by ${userId}`);

    res.json({
      message: 'Speaker added successfully',
      room: stripInternalStreamFields(updated),
    });
  } catch (error) {
    logger.error('Error adding speaker:', { userId: req.user?.id, roomId: req.params.id, speakerId: req.body.userId, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error adding speaker',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Remove speaker (room manager only)
 * DELETE /api/rooms/:id/speakers/:userId
 */
router.delete('/:id/speakers/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    const id = getParam(req, 'id');
    const speakerId = getParam(req, 'userId');

    if (!currentUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await loadRoom(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, currentUserId, res, 'Only a room manager can remove speakers'))) {
      return;
    }

    // Cannot remove host as speaker
    if (speakerId === room.host) {
      return res.status(400).json({ message: 'Cannot remove host as speaker' });
    }

    // Remove from speakers
    const remaining = room.speakers.filter((s) => s !== speakerId);

    if (remaining.length === room.speakers.length) {
      return res.status(404).json({ message: 'User is not a speaker' });
    }

    const updated = await updateRoom(room.id, { speakers: remaining });
    if (!updated) {
      return res.status(404).json({ message: 'Room not found' });
    }

    logger.info(`User ${speakerId} removed as speaker from room ${id} by ${currentUserId}`);

    res.json({
      message: 'Speaker removed successfully',
      room: stripInternalStreamFields(updated),
    });
  } catch (error) {
    logger.error('Error removing speaker:', { userId: req.user?.id, roomId: req.params.id, speakerId: req.params.userId, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error removing speaker',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Get a LiveKit token for joining a room's audio room
 * POST /api/rooms/:id/token
 *
 * For broadcast rooms, everyone except the host gets a listen-only token.
 */
router.post('/:id/token', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = isLiveEntityId(id) ? await findPublicRoomById(id) : undefined;
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room is not live' });
    }

    let token: string;

    if (room.type === RoomType.BROADCAST) {
      // Broadcast rooms: only host gets publish permissions
      const isHost = room.host === userId;
      token = await generateBroadcastToken(room.id, userId, isHost);
    } else {
      // Talk / Stage rooms: determine role normally
      let role: 'host' | 'speaker' | 'listener' = 'listener';
      if (room.host === userId) {
        role = 'host';
      } else if (room.speakers.includes(userId)) {
        role = 'speaker';
      }
      token = await generateRoomToken(room.id, userId, role);
    }

    res.json({
      token,
      url: process.env.LIVEKIT_URL || '',
    });
  } catch (error) {
    logger.error('Error generating room token:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error generating token',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Start external live stream (room manager only)
 * POST /api/rooms/:id/stream
 * Body: { url: string, title?, image?, description? }
 */
router.post('/:id/stream', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');
    const { url, title, image, description } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ message: 'url is required' });
    }

    const trimmedUrl = url.trim();

    try {
      const parsed = new URL(trimmedUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ message: 'Only http and https URLs are supported' });
      }
    } catch {
      return res.status(400).json({ message: 'Invalid URL format' });
    }

    const room = await loadRoom(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can add a live stream'))) {
      return;
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room must be live to add a stream' });
    }

    await startUrlIngressForRoom(
      room,
      room.id,
      {
        url: trimmedUrl,
        title: title ? String(title).trim() : undefined,
        image: image ? String(image).trim() : undefined,
        description: description ? String(description).trim() : undefined,
      },
      res,
      userId,
    );
  } catch (error) {
    logger.error('Error starting stream:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error starting stream',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Start streaming a Syra podcast episode into the room (room manager only)
 * POST /api/rooms/:id/stream/podcast
 * Body: { syraPodcastId?: string, episodeId: string }
 *
 * Rate limiting is handled by the global Oxy limiter (`createOxyRateLimit`,
 * `app.use(rateLimiter)` in server.ts) that fronts every route — like the sibling
 * `/:id/stream` routes, this handler carries no per-route limiter of its own.
 *
 * The client sends only the episode reference — never a media URL. The backend
 * resolves the episode's playable `enclosureUrl` + metadata server-side from the
 * Syra catalog (O(1) by-id lookup), validates the audio URL is a reachable,
 * public, audio upstream (SSRF-guarded), then feeds it into the SAME LiveKit URL
 * ingress path as `POST /:id/stream`. When `syraPodcastId` is supplied it is
 * cross-checked against the resolved episode's show to reject a mismatched
 * pairing.
 *
 * An optional `queue` of `{ syraPodcastId?, episodeId }[]` (the episodes AFTER
 * this one) is persisted as `room_media_queue_items` and advanced manually via
 * `POST /:id/stream/podcast/next` or automatically when the current ingress ends.
 */
router.post('/:id/stream/podcast', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');
    const { syraPodcastId, episodeId, queue } = req.body ?? {};

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (typeof episodeId !== 'string' || !episodeId.trim()) {
      return res.status(400).json({ message: 'episodeId is required' });
    }

    if (syraPodcastId !== undefined && typeof syraPodcastId !== 'string') {
      return res.status(400).json({ message: 'syraPodcastId must be a string' });
    }

    const parsedQueue = parsePodcastQueue(queue);
    if (!parsedQueue.ok) {
      return res.status(400).json({ message: parsedQueue.message });
    }

    const trimmedEpisodeId = episodeId.trim();
    const trimmedPodcastId =
      typeof syraPodcastId === 'string' && syraPodcastId.trim() ? syraPodcastId.trim() : undefined;

    const room = await loadRoom(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can add a live stream'))) {
      return;
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room must be live to add a stream' });
    }

    // The remaining queue is handed down rather than staged on the room: it is
    // persisted in the same transaction as the ingress fields, only when the
    // first episode actually starts.
    const outcome = await startPodcastEpisodeStream(
      room,
      room.id,
      trimmedEpisodeId,
      trimmedPodcastId,
      parsedQueue.queue,
      userId,
    );
    if (!outcome.ok) {
      return res.status(outcome.status).json(outcome.body);
    }

    res.json({
      message: 'Stream started successfully',
      ingressId: outcome.ingressId,
      url: outcome.url,
    });
  } catch (error) {
    logger.error('Error starting podcast stream:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error starting stream',
      error: describeErrorSafely(error),
    });
  }
});

/** How the caller seeded a track stream — flags which id branch to resolve. */
type ParsedTrackStreamBody =
  | { ok: true; kind: 'track'; trackId: string; queue: MediaQueueItem[] }
  | { ok: true; kind: 'album'; albumId: string }
  | { ok: true; kind: 'playlist'; playlistId: string }
  | { ok: false; message: string };

/**
 * Parse + validate the `POST /:id/stream/track` body. Exactly one of `trackId`,
 * `albumId`, `playlistId` must be supplied. `trackId` may carry an optional
 * `queue` of `{ trackId }[]` (the tracks AFTER this one); `albumId` / `playlistId`
 * seed the queue server-side from the container's ordered, playable tracks.
 */
function parseTrackStreamBody(body: unknown): ParsedTrackStreamBody {
  const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const trackId = typeof obj.trackId === 'string' ? obj.trackId.trim() : '';
  const albumId = typeof obj.albumId === 'string' ? obj.albumId.trim() : '';
  const playlistId = typeof obj.playlistId === 'string' ? obj.playlistId.trim() : '';

  const supplied = [trackId, albumId, playlistId].filter(Boolean).length;
  if (supplied === 0) {
    return { ok: false, message: 'One of trackId, albumId or playlistId is required' };
  }
  if (supplied > 1) {
    return { ok: false, message: 'Provide only one of trackId, albumId or playlistId' };
  }

  if (trackId) {
    const parsedQueue = parseTrackQueue(obj.queue);
    if (!parsedQueue.ok) {
      return { ok: false, message: parsedQueue.message };
    }
    return { ok: true, kind: 'track', trackId, queue: parsedQueue.queue };
  }
  if (albumId) {
    return { ok: true, kind: 'album', albumId };
  }
  return { ok: true, kind: 'playlist', playlistId };
}

/**
 * Start streaming a Syra music track into the room — a "listening party" (room
 * manager only). The music-shaped sibling of `POST /:id/stream/podcast`.
 * POST /api/rooms/:id/stream/track
 * Body: { trackId, queue?: { trackId }[] } | { albumId } | { playlistId }
 *
 * Rate limiting is handled by the global Oxy limiter (`app.use(rateLimiter)` in
 * server.ts) that fronts every route — like the sibling `/:id/stream*` routes,
 * this handler carries no per-route limiter of its own.
 *
 * COPYRIGHT / LICENSING: streaming a full track into a room is a broadcast, not a
 * private listen — this is scoped to Syra's OWN catalog + rights model (see
 * `utils/syraMedia.ts`) and the host is shown a rights disclaimer in the picker.
 *
 * The client sends only ids — never a media URL. The backend resolves the
 * playable audio (presigned original → tokenized HLS) +
 * metadata server-side, SSRF-validates it, then feeds it into the SAME LiveKit
 * URL ingress as the other stream routes. `albumId` / `playlistId` additionally
 * seed the up-next queue from the container's ordered, playable tracks; the
 * queue auto-advances via `/stream/podcast/next` or the LiveKit `ingress_ended`
 * webhook, and may mix with podcast items.
 */
router.post('/:id/stream/track', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = parseTrackStreamBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.message });
    }

    const room = await loadRoom(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can add a live stream'))) {
      return;
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room must be live to add a stream' });
    }

    // Resolve the head track to play now + the remaining queue to stage. For a
    // container (album/playlist) the ordered, playable tracks are resolved
    // server-side; the head plays now and the rest (capped) become the up-next
    // queue. Only ids are stored — audio is resolved per item at play-time.
    let firstTrackId: string;
    let queue: MediaQueueItem[];
    if (parsed.kind === 'track') {
      firstTrackId = parsed.trackId;
      queue = parsed.queue;
    } else {
      const items = parsed.kind === 'album'
        ? await resolveAlbumTracks(parsed.albumId)
        : await resolvePlaylistTracks(parsed.playlistId);
      const [head, ...rest] = items;
      if (!head?.trackId) {
        return res.status(404).json({ message: 'No playable tracks found' });
      }
      firstTrackId = head.trackId;
      queue = rest.slice(0, MAX_MEDIA_QUEUE_LENGTH);
    }

    const outcome = await startTrackStream(room, room.id, firstTrackId, queue, userId);
    if (!outcome.ok) {
      return res.status(outcome.status).json(outcome.body);
    }

    res.json({
      message: 'Stream started successfully',
      ingressId: outcome.ingressId,
      url: outcome.url,
    });
  } catch (error) {
    logger.error('Error starting track stream:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error starting stream',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Advance to the next queued podcast episode, or stop the stream when the queue
 * is drained (room manager only, room must be LIVE).
 * POST /api/rooms/:id/stream/podcast/next
 *
 * Pops the head of the room's queue and drives it through the identical
 * resolve → SSRF-validate → ingress path as `POST /:id/stream/podcast`. Returns
 * `{ message, ingressId, url }` when the next episode starts, or
 * `{ message, ended: true }` when the queue was empty and the stream stopped.
 */
router.post('/:id/stream/podcast/next', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await loadRoom(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can control the stream'))) {
      return;
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room must be live to advance the stream' });
    }

    const result = await advancePodcastQueueForRoom(room, room.id, userId);
    if (result.kind === 'ended') {
      return res.json({ message: 'Stream ended', ended: true });
    }
    if (result.kind === 'error') {
      return res.status(result.status).json(result.body);
    }

    res.json({
      message: 'Stream started successfully',
      ingressId: result.ingressId,
      url: result.url,
    });
  } catch (error) {
    logger.error('Error advancing podcast stream:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error advancing stream',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Stop external live stream (room manager only)
 * DELETE /api/rooms/:id/stream
 */
router.delete('/:id/stream', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await loadRoom(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can remove the stream'))) {
      return;
    }

    if (!room.activeIngressId) {
      return res.status(400).json({ message: 'No active stream' });
    }

    // Delete the ingress from LiveKit
    await deleteIngress(room.activeIngressId);

    // Clear all stream fields (incl. progress + the media queue)
    await stopRoomStreamFields(room.id);

    logger.info(`Live stream stopped in room ${id}`);

    // Notify participants via both current and legacy namespaces
    emitStreamStopped(room.id);

    res.json({ message: 'Stream stopped successfully' });
  } catch (error) {
    logger.error('Error stopping stream:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error stopping stream',
      error: describeErrorSafely(error),
    });
  }
});

type UpdateStreamMetadataBody = {
  url?: unknown;
  title?: unknown;
  image?: unknown;
  description?: unknown;
};

type ParsedOptionalText =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

/**
 * An optional stream text field: a non-empty trimmed string, or `null` to CLEAR.
 *
 * Returns `null` rather than `undefined` for the empty case because that value
 * is written straight into an update, where `undefined` means "leave alone" —
 * the Mongoose original returned `undefined` and relied on `save()` issuing
 * `$unset`, so carrying that spelling forward would make "clear the stream
 * title" silently keep the old one.
 */
const parseOptionalStreamText = (value: unknown, field: string): ParsedOptionalText => {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }

  if (typeof value !== 'string') {
    return { ok: false, message: `${field} must be a string` };
  }

  const trimmed = value.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
};

/**
 * Update stream metadata (room manager only)
 * PATCH /api/rooms/:id/stream
 * Body: { url?, title?, image?, description? }
 */
router.patch('/:id/stream', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');
    const { url, title, image, description } = req.body as UpdateStreamMetadataBody;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    let nextStreamUrl: string | undefined;
    if (url !== undefined) {
      if (typeof url !== 'string') {
        return res.status(400).json({ message: 'url must be a string' });
      }

      const trimmedUrl = url.trim();
      if (!trimmedUrl) {
        return res.status(400).json({ message: 'url cannot be empty' });
      }

      try {
        const parsed = new URL(trimmedUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return res.status(400).json({ message: 'Only http and https URLs are supported' });
        }
      } catch {
        return res.status(400).json({ message: 'Invalid URL format' });
      }

      nextStreamUrl = trimmedUrl;
    }

    const parsedTitle = parseOptionalStreamText(title, 'title');
    if (!parsedTitle.ok) {
      return res.status(400).json({ message: parsedTitle.message });
    }

    const parsedImage = parseOptionalStreamText(image, 'image');
    if (!parsedImage.ok) {
      return res.status(400).json({ message: parsedImage.message });
    }

    const parsedDescription = parseOptionalStreamText(description, 'description');
    if (!parsedDescription.ok) {
      return res.status(400).json({ message: parsedDescription.message });
    }

    const room = await loadRoom(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can update stream info'))) {
      return;
    }

    if (!room.activeIngressId && nextStreamUrl === undefined) {
      return res.status(400).json({ message: 'No active stream to update' });
    }

    // `undefined` LEAVES ALONE, so a field the caller did not name is untouched;
    // the parsed `null`s above are what actually clear one.
    const update: Parameters<typeof updateRoom>[1] = {};

    if (nextStreamUrl !== undefined && nextStreamUrl !== (room.activeStreamUrl ?? undefined)) {
      if (room.status !== RoomStatus.LIVE) {
        return res.status(400).json({ message: 'Room must be live to update stream URL' });
      }

      // SSRF-guarded probe of the new URL before replacing the ingress -- the same
      // gate the stream-start paths run, so a URL swap can never bypass validation.
      const validation = await validatePlayableAudioUrl(nextStreamUrl);
      if (!validation.ok) {
        return res.status(validation.status).json({ message: validation.message });
      }

      let ingressResult: IngressReplacementResult;
      try {
        await ensureLiveKitRoomForRoom(room.id, room.maxParticipants);
        ingressResult = await createIngressReplacingExisting(room, room.id, () =>
          createRoomUrlIngress(room.id, nextStreamUrl)
        );
        await cleanupPreviousIngressAfterReplacement(room.id, ingressResult);
      } catch (liveKitError) {
        return sendLiveKitIngressError(res, liveKitError, 'update-url-ingress', {
          roomId: room.id,
          userId,
        });
      }

      update.activeIngressId = ingressResult.ingress.ingressId;
      update.activeStreamUrl = nextStreamUrl;
      // Switching to a URL ingress leaves RTMP mode, so the still-valid RTMP
      // PUBLISHING KEY must actually be cleared — `null`, never `undefined`.
      update.rtmpUrl = null;
      update.rtmpStreamKey = null;
    }

    // Update metadata fields
    if (title !== undefined) update.streamTitle = parsedTitle.value;
    if (image !== undefined) update.streamImage = parsedImage.value;
    if (description !== undefined) update.streamDescription = parsedDescription.value;

    const updated = await updateRoom(room.id, update);
    if (!updated) {
      return res.status(404).json({ message: 'Room not found' });
    }

    logger.info(`Stream metadata updated for room ${id}`);

    // Notify participants via socket with updated metadata
    emitStreamStarted(room.id, updated);

    res.json({ message: 'Stream info updated', url: updated.activeStreamUrl || null });
  } catch (error) {
    logger.error('Error updating stream metadata:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error updating stream info',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Generate RTMP stream key (room manager only)
 * POST /api/rooms/:id/stream/rtmp
 * Body: { title?, image?, description? }
 */
router.post('/:id/stream/rtmp', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');
    const { title, image, description } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await loadRoom(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can configure streaming'))) {
      return;
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room must be live to configure streaming' });
    }

    let ingressResult: IngressReplacementResult;
    try {
      await ensureLiveKitRoomForRoom(room.id, room.maxParticipants);
      ingressResult = await createIngressReplacingExisting(room, room.id, () =>
        createRoomRtmpIngress(room.id)
      );
      await cleanupPreviousIngressAfterReplacement(room.id, ingressResult);
    } catch (liveKitError) {
      return sendLiveKitIngressError(res, liveKitError, 'create-rtmp-ingress', {
        roomId: room.id,
        userId,
      });
    }

    // LiveKit may return an empty url if the RTMP service doesn't have a
    // public URL configured.  Derive a fallback from LIVEKIT_URL.
    let rtmpUrl = ingressResult.ingress.url || '';
    if (!rtmpUrl) {
      const host = (process.env.LIVEKIT_URL || '')
        .replace(/^wss?:\/\//, '')
        .replace(/\/+$/, '');
      if (host) rtmpUrl = `rtmp://${host}:1935/live`;
    }

    // Persist ingress info + metadata, CLEARING the URL-mode fields with `null`
    // rather than `undefined` — see `applyUrlIngressToRoom` for why the
    // distinction is load-bearing here.
    const updated = await updateRoom(room.id, {
      activeIngressId: ingressResult.ingress.ingressId,
      activeStreamUrl: null,
      rtmpUrl,
      rtmpStreamKey: ingressResult.ingress.streamKey,
      streamTitle: title ? String(title).trim() : null,
      streamImage: image ? String(image).trim() : null,
      streamDescription: description ? String(description).trim() : null,
    });

    if (!updated) {
      return res.status(404).json({ message: 'Room not found' });
    }

    logger.info(`RTMP ingress created for room ${id}: ${ingressResult.ingress.ingressId}`);

    // Notify participants via socket (metadata only -- no credentials)
    emitStreamStarted(room.id, updated);

    res.json({
      message: 'RTMP stream key generated',
      rtmpUrl,
      streamKey: ingressResult.ingress.streamKey,
    });
  } catch (error) {
    logger.error('Error generating RTMP key:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error generating stream key',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Delete a room (room manager only)
 * DELETE /api/rooms/:id
 */
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await loadRoom(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can delete the room'))) {
      return;
    }

    // Cannot delete a live room
    if (room.status === RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Cannot delete a live room. End it first.' });
    }

    // The media queue goes with it (`ON DELETE CASCADE`); its recordings survive
    // with `room_id = null` (`ON DELETE SET NULL`), and its series episode-log
    // rows keep their history the same way.
    await deleteRoom(room.id);

    logger.info(`Room deleted: ${id} by ${userId}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting room:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error deleting room',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Archive/Unarchive a room (room manager only)
 * PATCH /api/rooms/:id/archive
 */
router.patch('/:id/archive', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await loadRoom(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can archive the room'))) {
      return;
    }

    // Cannot archive a live room
    if (room.status === RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Cannot archive a live room. End it first.' });
    }

    // Toggle archived status
    const updated = await updateRoom(room.id, { archived: !room.archived });
    if (!updated) {
      return res.status(404).json({ message: 'Room not found' });
    }

    logger.info(`Room ${updated.archived ? 'archived' : 'unarchived'}: ${id} by ${userId}`);

    res.json({ success: true, archived: updated.archived });
  } catch (error) {
    logger.error('Error archiving room:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error archiving room',
      error: describeErrorSafely(error),
    });
  }
});

// ---------------------------------------------------------------------------
// Recording endpoints (room-scoped)
// ---------------------------------------------------------------------------

/**
 * Start recording a live room (room manager only)
 * POST /api/rooms/:id/recording/start
 */
router.post('/:id/recording/start', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await loadRoom(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can start recording'))) {
      return;
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room must be live to start recording' });
    }

    if (room.recordingEgressId) {
      return res.status(400).json({ message: 'Recording is already active' });
    }

    const recording = await startRecordingForRoom(room);

    const io = global.io;
    if (io) {
      io.of('/rooms').to(`room:${id}`).emit('room:recording:started', {
        roomId: id,
        recordingId: recording.id,
        timestamp: new Date().toISOString(),
      });
    }

    logger.info(`Recording manually started for room ${id}`);

    res.json({
      message: 'Recording started',
      recording,
    });
  } catch (error) {
    logger.error('Error starting recording:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error starting recording',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * Stop recording a live room (room manager only)
 * POST /api/rooms/:id/recording/stop
 */
router.post('/:id/recording/stop', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await loadRoom(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can stop recording'))) {
      return;
    }

    if (!room.recordingEgressId) {
      return res.status(400).json({ message: 'No active recording' });
    }

    // `stopRecordingForRoom` clears `recordingEgressId` itself. The Mongo
    // version relied on a bare `room.save()` here to persist a field it had
    // only set in memory, which under drizzle would have persisted nothing.
    await stopRecordingForRoom(room, 'manual');

    logger.info(`Recording manually stopped for room ${id}`);

    res.json({ message: 'Recording stopped' });
  } catch (error) {
    logger.error('Error stopping recording:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error stopping recording',
      error: describeErrorSafely(error),
    });
  }
});

/**
 * List recordings for a room (access-filtered)
 * GET /api/rooms/:id/recordings
 */
router.get('/:id/recordings', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');
    const { limit = '20', cursor } = req.query;

    const room = isLiveEntityId(id) ? await findPublicRoomById(id) : undefined;
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const canManage = userId
      ? await canManageRoom(room, userId)
      : false;

    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 100);

    const recordings = await listRoomRecordings({
      roomId: room.id,
      canManage,
      userId,
      cursor: typeof cursor === 'string' ? cursor : undefined,
      limit: limitNum + 1,
    });

    const hasMore = recordings.length > limitNum;
    const recordingsToReturn = hasMore ? recordings.slice(0, limitNum) : recordings;
    const nextCursor = hasMore && recordingsToReturn.length > 0
      ? recordingsToReturn[recordingsToReturn.length - 1].id
      : undefined;

    res.json({
      recordings: recordingsToReturn,
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logger.error('Error fetching recordings:', { userId: req.user?.id, roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({
      message: 'Error fetching recordings',
      error: describeErrorSafely(error),
    });
  }
});

// ---------------------------------------------------------------------------
// Room image upload
// ---------------------------------------------------------------------------

/**
 * Upload room/stream image
 * POST /api/rooms/:id/image
 */
router.post('/:id/image', uploadMiddleware.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const id = getParam(req, 'id');

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!req.file) return res.status(400).json({ message: 'No file provided' });

    const room = await loadRoom(id);
    if (!room) return res.status(404).json({ message: 'Room not found' });
    if (!(await sendForbiddenUnlessRoomManager(room, userId, res, 'Only a room manager can upload a room image'))) {
      return;
    }

    const { buffer, contentType } = await processImage(req.file.buffer, 'roomImage');
    const objectKey = getAgoraRoomImageKey(id as string);

    const oldStreamImageKey = cdnUrlToKey(room.streamImage);
    if (oldStreamImageKey && oldStreamImageKey !== objectKey) {
      deleteObject(oldStreamImageKey).catch(() => {});
    }

    const cdnUrl = await uploadObject(objectKey, buffer, contentType, 'public-read');
    await updateRoom(room.id, { streamImage: cdnUrl });

    res.json({ streamImage: cdnUrl });
  } catch (error) {
    logger.error('Error uploading room image:', { roomId: req.params.id, error: describeErrorSafely(error) });
    res.status(500).json({ message: 'Error uploading image', error: describeErrorSafely(error) });
  }
});

export default router;
