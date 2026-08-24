import { and, asc, eq } from 'drizzle-orm';
import { isLiveEntityId } from '@oxyhq/db';
import type { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { HlsRendition } from '@syra/shared-types';
import { env } from '../config/env';
import { getDb } from '../db/postgres';
import { trackHlsRenditions, tracks } from '../db/schema/catalog';
import { trackKeys } from '../db/schema/trackKeys';
import { findMusicPreferences } from '../db/user/musicPreferences';
import { mintStreamToken, verifyStreamToken } from '../services/stream/streamToken';
import { buildMasterPlaylistFor, buildVariantPlaylistFor } from '../services/stream/manifestService';
import { getUserEntitlement } from '../services/premium/entitlement';
import { computeMaxBitrateKbps } from '../services/stream/audioQuality';

const CONTENT_TYPE_OCTET_STREAM = 'application/octet-stream';
const CONTENT_TYPE_HLS_PLAYLIST = 'application/vnd.apple.mpegurl';
const CACHE_CONTROL_NO_STORE = 'no-store';
const CACHE_CONTROL_STREAM_RESOLUTION = 'private, max-age=300';
const CACHE_CONTROL_PLAYLIST = 'private, max-age=300, stale-while-revalidate=1800';

/**
 * Stream token TTL covers a full listening session (play, pause, resume).
 * HLS sub-requests (key, master, variants) are re-fetchable within this window.
 */
const STREAM_SESSION_TTL_SEC = 3600;

// ── Access helper ─────────────────────────────────────────────────────────────

export type StreamAccess =
  | { ok: true; maxBitrateKbps: number }
  | { ok: false };

/**
 * Resolve authorization for a stream sub-resource request and return the
 * effective bitrate cap for this session.
 *
 * - Valid `?t=` token bound to this trackId → cap from token claims.
 * - Bearer session (req.user.id) → recompute cap from live entitlement + prefs.
 * - Neither → { ok: false }.
 */
export async function resolveStreamAccess(
  req: AuthRequest,
  trackId: string,
): Promise<StreamAccess> {
  const rawToken = req.query?.t;
  if (typeof rawToken === 'string' && rawToken) {
    const claims = verifyStreamToken(rawToken);
    if (claims && claims.trackId === trackId) {
      return { ok: true, maxBitrateKbps: claims.maxBitrateKbps };
    }
  }

  if (req.user?.id) {
    const [entitlement, prefs] = await Promise.all([
      getUserEntitlement(req.user.id),
      findMusicPreferences(req.user.id),
    ]);
    const maxBitrateKbps = computeMaxBitrateKbps(
      { audioQuality: prefs?.audioQuality, dataSaver: prefs?.dataSaver },
      entitlement,
    );
    return { ok: true, maxBitrateKbps };
  }

  return { ok: false };
}

// ── Podcast episode access ────────────────────────────────────────────────────

/**
 * The parts of a show that decide who may reach its episodes' media.
 *
 * Structural rather than the `podcasts` row type, so the caller passes what it
 * already joined and nothing here can start depending on a column it was not
 * given.
 */
export interface EpisodeShowAccess {
  readonly visibility: string;
  readonly ownerOxyUserId: string | null;
}

/**
 * Whether THIS request is the show owner's — by bearer session, or by a stream
 * token minted for the owner.
 *
 * The token arm is what keeps a private show playable at all: a native player
 * fetches `/master.m3u8`, `/v/:variant` and `/key` from the URL alone, with no
 * `Authorization` header, so the only identity those requests carry is the one
 * inside `?t=`. `mintStreamToken` stamps `userId` from the authenticated
 * `/stream` call that issued it, and it is signed, so it cannot be edited into
 * somebody else's.
 *
 * The token is checked against BOTH this episode's id and the owner's id. Either
 * alone is not enough: an owner's token for episode A must not open episode B,
 * and a stranger's valid token for this same episode must not open it either.
 */
function isShowOwnerRequest(
  req: AuthRequest,
  episodeId: string,
  show: EpisodeShowAccess,
): boolean {
  if (show.ownerOxyUserId === null) return false;
  if (req.user?.id === show.ownerOxyUserId) return true;

  const rawToken = req.query?.t;
  if (typeof rawToken !== 'string' || !rawToken) return false;
  const claims = verifyStreamToken(rawToken);
  return !!claims && claims.trackId === episodeId && claims.userId === show.ownerOxyUserId;
}

/**
 * Whether a request may reach an episode's MEDIA at all, on the show's audience
 * alone.
 *
 * `public` and `unlisted` are ANONYMOUS on purpose, and that is not an oversight
 * to be tightened later: `/audio` is the enclosure URL published in the generated
 * RSS feed, so Apple Podcasts, Overcast and Podcast Index fetch it with no
 * credentials, and it is also the origin proxy for mirrored RSS episodes. An
 * auth requirement there would break every podcast client at once. `unlisted`
 * shares that rule because an unlisted show's whole grant IS its URL.
 *
 * Only `private` asks who is calling — and the answer is the owner, nobody else.
 * Note what this deliberately does NOT do: it never widens access for a
 * signed-in stranger. Being authenticated is not a claim on anything here.
 */
export function requestMayReachShowMedia(
  req: AuthRequest,
  episodeId: string,
  show: EpisodeShowAccess,
): boolean {
  if (show.visibility !== 'private') return true;
  return isShowOwnerRequest(req, episodeId, show);
}

/**
 * Why an episode request was refused, because the two reasons must not share a
 * status code.
 *
 * `unauthenticated` is "you brought no credentials" — 401, the same answer an
 * anonymous caller has always had for an HLS sub-resource, and it says nothing
 * about the episode. `hidden` is "this show is not yours to see" — 404, so a
 * private episode is indistinguishable from an id that names nothing. Collapsing
 * them into one `{ ok: false }` and answering 401 for both would rebuild the
 * existence oracle at the media layer: 404 for a made-up id, 401 for a real
 * private one, and a caller can sort ids by status code without ever being
 * allowed to play anything. Measured — that is exactly what the first version of
 * this function did, and the matrix suite caught it.
 */
export type EpisodeAccess =
  | { ok: true; maxBitrateKbps: number }
  | { ok: false; reason: 'hidden' }
  | { ok: false; reason: 'unauthenticated' };

/**
 * Authorization for an episode's HLS sub-resources: the show's audience gate,
 * then the same bitrate-cap resolution tracks use.
 *
 * The two halves are separate questions and both have to be asked. Before this
 * existed, the episode endpoints called `resolveStreamAccess` directly — which
 * answers only "does this request carry a cap I can compute", so ANY signed-in
 * user passed it for ANY episode id. That is correct for music, where the
 * catalogue is public by construction and the cap IS the entitlement; it is not
 * correct for an episode, whose show may be private.
 *
 * ORDER MATTERS: the audience gate runs first, so a caller asking for a private
 * episode gets `hidden` (404) whether or not they are signed in, rather than a
 * 401 that confirms the id.
 */
export async function resolveEpisodeAccess(
  req: AuthRequest,
  episodeId: string,
  show: EpisodeShowAccess,
): Promise<EpisodeAccess> {
  if (!requestMayReachShowMedia(req, episodeId, show)) return { ok: false, reason: 'hidden' };
  const access = await resolveStreamAccess(req, episodeId);
  return access.ok ? access : { ok: false, reason: 'unauthenticated' };
}

// ── Track reads ───────────────────────────────────────────────────────────────

/**
 * The columns every handler here needs, and no others.
 *
 * Nothing in this file SERIALIZES a track — it answers with a URL, a key, or a
 * manifest — so a narrow projection is right here in a way it was not in
 * `recommendationService`, where the same shape produced a DTO with `id: ""`.
 * The difference is whether a row leaves the module as a DTO; none does.
 */
const PLAYBACK_TRACK_COLUMNS = {
  isAvailable: tracks.isAvailable,
  copyrightRemoved: tracks.copyrightRemoved,
  status: tracks.status,
  hlsMasterKey: tracks.hlsMasterKey,
} as const;

/** Picked off the schema type, so a column changing shape fails here. */
type PlaybackTrackRow = Pick<
  typeof tracks.$inferSelect,
  keyof typeof PLAYBACK_TRACK_COLUMNS
>;

async function findPlaybackTrack(trackId: string): Promise<PlaybackTrackRow | undefined> {
  const [track] = await getDb()
    .select(PLAYBACK_TRACK_COLUMNS)
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);

  return track;
}

/**
 * The HLS ladder, in ladder order.
 *
 * A child table since Task 4, so it is a second read rather than an embedded
 * array — and `position` is what orders it. `bitrateKbps` ascending would
 * usually agree, but the manifest builders sort by bitrate themselves, so the
 * stored order is the one thing this read must not invent.
 */
async function findHlsRenditions(trackId: string): Promise<HlsRendition[]> {
  return getDb()
    .select({
      manifestKey: trackHlsRenditions.manifestKey,
      bitrateKbps: trackHlsRenditions.bitrateKbps,
      encrypted: trackHlsRenditions.encrypted,
    })
    .from(trackHlsRenditions)
    .where(eq(trackHlsRenditions.trackId, trackId))
    .orderBy(asc(trackHlsRenditions.position));
}

// ── Track availability guard ──────────────────────────────────────────────────

/**
 * The PLAYBACK authority, and the third of the three predicates.
 *
 * It was `isAvailable !== false && !copyrightRemoved` against Mongo, where both
 * fields were optional — so it disagreed with the catalog filter on an absent
 * `isAvailable` and with the in-memory catalog predicate on a truthy
 * non-boolean `copyrightRemoved`. A takedown that set only `copyrightRemoved`
 * to something other than exactly `true` stayed listed, searchable, AND
 * playable.
 *
 * Both columns are `NOT NULL` booleans in Postgres, so neither disagreeing
 * shape is representable, and this is now the literal mirror of
 * `db/catalog/visibility.ts`'s `isPlayableTrack` — same comparison, same
 * direction. `__tests__/visibility.agreement.test.ts` holds all three to that
 * over real rows rather than to a comment.
 */
export function isTrackPlayable(track: { isAvailable: boolean; copyrightRemoved: boolean }): boolean {
  return track.isAvailable === true && track.copyrightRemoved === false;
}

// ── Manifest token helper ─────────────────────────────────────────────────────

/**
 * Return the stream token to embed in manifest URLs.
 * Reuses `?t=` for token-only requests (native players); otherwise mints a
 * fresh token with the given cap for bearer requests.
 */
function resolveManifestToken(
  req: AuthRequest,
  trackId: string,
  maxBitrateKbps: number,
): string {
  const rawToken = req.query?.t;
  if (typeof rawToken === 'string' && rawToken) return rawToken;
  return mintStreamToken(
    { trackId, userId: req.user?.id ?? '', maxBitrateKbps },
    STREAM_SESSION_TTL_SEC,
  );
}

// ── Resolver ─────────────────────────────────────────────────────────────────

/**
 * GET /api/stream/:trackId
 *
 * Issues a playback session for the requested track. Requires a real bearer
 * session (not a stream token) — it is the entrypoint that MINTS tokens.
 *
 * Response shape:
 *   - HLS:     { url, type: 'hls', expiresAt }  (url includes ?t=<streamToken>)
 *
 * The token embeds maxBitrateKbps derived from the user's entitlement + prefs.
 * Free users receive cap=160; premium users receive cap=320; data-saver forces 96.
 *
 * Error codes:
 *   401 — no session; 400 — bad ObjectId; 404 — not found; 403 — unavailable;
 *   409 — processing; 422 — failed / no playable source.
 */
export async function getStream(req: AuthRequest, res: Response): Promise<void> {
  // 1. Validate the track ID before touching auth (400 is auth-agnostic).
  const trackId = Array.isArray(req.params.trackId)
    ? req.params.trackId[0]
    : req.params.trackId;
  if (!trackId || !isLiveEntityId(trackId)) {
    res.status(400).json({ error: 'Invalid track ID' });
    return;
  }

  // 2. Load and validate availability (no auth needed to know a track is gone).
  const track = await findPlaybackTrack(trackId);
  if (!track) {
    res.status(404).json({ error: 'Track not found' });
    return;
  }

  if (!isTrackPlayable(track)) {
    res.status(403).json({ error: 'Track unavailable' });
    return;
  }

  // 3. Session required: HLS needs entitlement, and direct provider streaming
  //    is a per-user setting.
  if (!req.user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (track.status === 'processing') {
    res.status(409).json({ error: 'Track processing' });
    return;
  }

  const [entitlement, prefs] = await Promise.all([
    getUserEntitlement(req.user.id),
    findMusicPreferences(req.user.id),
  ]);
  const maxBitrateKbps = computeMaxBitrateKbps(
    { audioQuality: prefs?.audioQuality, dataSaver: prefs?.dataSaver },
    entitlement,
  );

  const hasLadder =
    track.status === 'ready' &&
    Boolean(track.hlsMasterKey) &&
    (await findHlsRenditions(trackId)).length > 0;

  if (hasLadder) {
    const token = mintStreamToken(
      { trackId, userId: req.user.id, maxBitrateKbps },
      STREAM_SESSION_TTL_SEC,
    );
    const base = env.STREAM_KEY_BASE_URL;
    const url = `${base}/api/stream/${trackId}/master.m3u8?t=${token}`;
    const expiresAt = new Date(Date.now() + STREAM_SESSION_TTL_SEC * 1000).toISOString();

    res.set('Cache-Control', CACHE_CONTROL_STREAM_RESOLUTION);
    res.set('Vary', 'Authorization');
    res.status(200).json({ url, type: 'hls', expiresAt });
    return;
  }

  res.status(422).json({ error: 'Track not playable' });
}

// ── Key endpoint ──────────────────────────────────────────────────────────────

/**
 * GET /api/stream/:trackId/key
 *
 * Serves the raw AES-128 key (16 bytes). Authorized by bearer or `?t=` token.
 * The key is NEVER cached client-side.
 *
 * Guards: ObjectId(1) → auth(2) → track(3) → availability(4) → key(5) → 200.
 */
export async function getStreamKey(req: AuthRequest, res: Response): Promise<void> {
  const trackId = Array.isArray(req.params.trackId)
    ? req.params.trackId[0]
    : req.params.trackId;

  if (!trackId || !isLiveEntityId(trackId)) {
    res.status(400).json({ error: 'Invalid track ID' });
    return;
  }

  const access = await resolveStreamAccess(req, trackId);
  if (!access.ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const track = await findPlaybackTrack(trackId);
  if (!track) {
    res.status(404).json({ error: 'Track not found' });
    return;
  }

  if (!isTrackPlayable(track)) {
    res.status(403).json({ error: 'Track unavailable' });
    return;
  }

  // `track_keys.track_id` is the CATALOGUE arm and only that — one column per
  // id space (see `schema/trackKeys.ts`), each with its own foreign key. A
  // locker upload's or an episode's key lives in a different column and cannot
  // be reached from here, which is what the shared column used to allow.
  const [trackKey] = await getDb()
    .select({ keyHex: trackKeys.keyHex })
    .from(trackKeys)
    .where(eq(trackKeys.trackId, trackId))
    .limit(1);

  if (!trackKey) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }

  res.set('Content-Type', CONTENT_TYPE_OCTET_STREAM);
  res.set('Cache-Control', CACHE_CONTROL_NO_STORE);
  res.status(200).send(Buffer.from(trackKey.keyHex, 'hex'));
}

// ── Master playlist ───────────────────────────────────────────────────────────

/**
 * GET /api/stream/:trackId/master.m3u8
 *
 * Serves the HLS master playlist filtered to the user's bitrate cap.
 * Variant paths are tokenized API URLs.
 *
 * Phase-5 seam: content-tier variant filtering is handled in `buildMasterPlaylist`.
 *
 * Guards: ObjectId(1) → auth(2) → track(3) → availability(4) → readiness(5) → 200.
 */
export async function getMasterPlaylist(req: AuthRequest, res: Response): Promise<void> {
  const trackId = Array.isArray(req.params.trackId)
    ? req.params.trackId[0]
    : req.params.trackId;

  if (!trackId || !isLiveEntityId(trackId)) {
    res.status(400).json({ error: 'Invalid track ID' });
    return;
  }

  const access = await resolveStreamAccess(req, trackId);
  if (!access.ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const track = await findPlaybackTrack(trackId);
  if (!track) {
    res.status(404).json({ error: 'Track not found' });
    return;
  }

  if (!isTrackPlayable(track)) {
    res.status(403).json({ error: 'Track unavailable' });
    return;
  }

  if (track.status === 'processing') {
    res.status(409).json({ error: 'Track processing' });
    return;
  }

  const renditions = await findHlsRenditions(trackId);
  if (!track.hlsMasterKey || renditions.length === 0) {
    res.status(404).json({ error: 'Master playlist not available' });
    return;
  }

  const maxBitrateKbps = access.maxBitrateKbps;
  const baseUrl = env.STREAM_KEY_BASE_URL;
  const token = resolveManifestToken(req, trackId, maxBitrateKbps);

  const playlist = await buildMasterPlaylistFor(
    { id: trackId, hls: renditions },
    { token, baseUrl, maxBitrateKbps, basePath: `/api/stream/${trackId}` },
  );
  res.set('Content-Type', CONTENT_TYPE_HLS_PLAYLIST);
  res.set('Cache-Control', CACHE_CONTROL_PLAYLIST);
  res.set('Vary', 'Authorization');
  res.status(200).send(playlist);
}

// ── Variant playlist ──────────────────────────────────────────────────────────

/**
 * GET /api/stream/:trackId/v/:variant
 *
 * Serves a rewritten variant playlist. `:variant` is e.g. `96.m3u8`.
 * Enforces the server-side bitrate cap: a request for a bitrate above the
 * user's entitlement cap is rejected with 403, even if the token is otherwise
 * valid. This prevents a tampered client from accessing premium quality.
 *
 * Guards: ObjectId(1) → auth(2) → track(3) → availability(4) → readiness(5) →
 *         variant parse(6) → cap enforcement(7) → 200.
 */
export async function getVariantPlaylist(req: AuthRequest, res: Response): Promise<void> {
  const trackId = Array.isArray(req.params.trackId)
    ? req.params.trackId[0]
    : req.params.trackId;

  if (!trackId || !isLiveEntityId(trackId)) {
    res.status(400).json({ error: 'Invalid track ID' });
    return;
  }

  const access = await resolveStreamAccess(req, trackId);
  if (!access.ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const track = await findPlaybackTrack(trackId);
  if (!track) {
    res.status(404).json({ error: 'Track not found' });
    return;
  }

  if (!isTrackPlayable(track)) {
    res.status(403).json({ error: 'Track unavailable' });
    return;
  }

  if (track.status === 'processing') {
    res.status(409).json({ error: 'Track processing' });
    return;
  }

  const renditions = await findHlsRenditions(trackId);
  if (renditions.length === 0) {
    res.status(404).json({ error: 'Variant playlist not available' });
    return;
  }

  // Parse variant param: "96.m3u8" → 96
  const variantParam = Array.isArray(req.params.variant)
    ? req.params.variant[0]
    : req.params.variant;
  const bitrateStr = (variantParam ?? '').replace(/\.m3u8$/i, '');
  const bitrateKbps = parseInt(bitrateStr, 10);

  if (!Number.isInteger(bitrateKbps) || bitrateKbps <= 0) {
    res.status(400).json({ error: 'Invalid variant' });
    return;
  }

  const rendition = renditions.find((r) => r.bitrateKbps === bitrateKbps);
  if (!rendition) {
    res.status(404).json({ error: `No rendition at ${bitrateKbps} kbps` });
    return;
  }

  // Server-side cap enforcement: reject requests above the entitlement cap.
  // access.maxBitrateKbps is always a number when ok is true.
  if (bitrateKbps > access.maxBitrateKbps) {
    res.status(403).json({ error: 'Quality not permitted' });
    return;
  }

  const baseUrl = env.STREAM_KEY_BASE_URL;
  const token = resolveManifestToken(req, trackId, access.maxBitrateKbps);

  const playlist = await buildVariantPlaylistFor(
    { id: trackId, hls: renditions },
    { bitrateKbps, token, baseUrl, basePath: `/api/stream/${trackId}` },
  );
  res.set('Content-Type', CONTENT_TYPE_HLS_PLAYLIST);
  res.set('Cache-Control', CACHE_CONTROL_PLAYLIST);
  res.set('Vary', 'Authorization');
  res.status(200).send(playlist);
}
