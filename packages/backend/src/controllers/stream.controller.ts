import mongoose from 'mongoose';
import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { TrackModel } from '../models/Track';
import { TrackKeyModel } from '../models/TrackKey';
import { mintStreamToken, verifyStreamToken } from '../services/stream/streamToken';
import { buildMasterPlaylist, buildVariantPlaylist } from '../services/stream/manifestService';

const CONTENT_TYPE_OCTET_STREAM = 'application/octet-stream';
const CONTENT_TYPE_HLS_PLAYLIST = 'application/vnd.apple.mpegurl';
const CACHE_CONTROL_NO_STORE = 'no-store';

/**
 * Stream token TTL covers a full listening session (play, pause, resume).
 * HLS sub-requests (key, master, variants) are re-fetchable within this window.
 */
const STREAM_SESSION_TTL_SEC = 3600;

// ── Auth helper ───────────────────────────────────────────────────────────────

/**
 * Authorize a stream sub-resource request. A request is authorized when:
 *  - The bearer session is present (`req.user.id`), OR
 *  - A `?t=` stream token is present, valid, and bound to exactly this trackId.
 *
 * Callers MUST check `claims.trackId === trackId` — a token minted for track A
 * does NOT authorize access to track B.
 */
export function authorizeStreamRequest(
  req: AuthRequest,
  trackId: string,
): { ok: boolean } {
  if (req.user?.id) return { ok: true };

  const rawToken = req.query?.t;
  if (typeof rawToken !== 'string') return { ok: false };

  const claims = verifyStreamToken(rawToken);
  if (!claims || claims.trackId !== trackId) return { ok: false };

  return { ok: true };
}

// ── Track availability guard (shared by both handlers) ───────────────────────

export function isTrackPlayable(track: { isAvailable?: boolean; copyrightRemoved?: boolean }): boolean {
  return track.isAvailable !== false && !track.copyrightRemoved;
}

// ── Resolver ─────────────────────────────────────────────────────────────────

/**
 * GET /api/stream/:trackId
 *
 * Issues a playback session for the requested track. Requires a real user
 * session (not just a stream token) — it is the entrypoint that MINTS tokens.
 *
 * Response shape:
 *   - Audius:  { url, type: 'audius', expiresAt }
 *   - HLS:     { url, type: 'hls', expiresAt }   (url includes ?t=<streamToken>)
 *
 * Error codes:
 *   401 — no session; 400 — bad ObjectId; 404 — not found; 403 — unavailable;
 *   409 — processing; 422 — failed / no playable source.
 */
export async function getStream(req: AuthRequest, res: Response): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const trackId = Array.isArray(req.params.trackId)
    ? req.params.trackId[0]
    : req.params.trackId;
  if (!trackId || !mongoose.Types.ObjectId.isValid(trackId)) {
    res.status(400).json({ error: 'Invalid track ID' });
    return;
  }

  const track = await TrackModel.findById(trackId).lean();
  if (!track) {
    res.status(404).json({ error: 'Track not found' });
    return;
  }

  if (!isTrackPlayable(track)) {
    res.status(403).json({ error: 'Track unavailable' });
    return;
  }

  // ── Audius branch ─────────────────────────────────────────────────────────
  if (track.source === 'audius') {
    if (!track.streamUrl) {
      res.status(404).json({ error: 'Stream URL not available' });
      return;
    }
    res.status(200).json({
      url: track.streamUrl,
      type: 'audius',
      expiresAt: null,
    });
    return;
  }

  // ── HLS branch ────────────────────────────────────────────────────────────
  if (track.status === 'processing') {
    res.status(409).json({ error: 'Track processing' });
    return;
  }

  if (
    track.status === 'ready' &&
    track.hlsMasterKey &&
    track.hls &&
    track.hls.length > 0
  ) {
    const token = mintStreamToken(
      { trackId, userId: req.user.id },
      STREAM_SESSION_TTL_SEC,
    );
    const base = process.env.STREAM_KEY_BASE_URL ?? '';
    const url = `${base}/api/stream/${trackId}/master.m3u8?t=${token}`;
    const expiresAt = new Date(Date.now() + STREAM_SESSION_TTL_SEC * 1000).toISOString();

    res.status(200).json({ url, type: 'hls', expiresAt });
    return;
  }

  // failed or no playable source
  res.status(422).json({ error: 'Track not playable' });
}

// ── Key endpoint ──────────────────────────────────────────────────────────────

/**
 * GET /api/stream/:trackId/key
 *
 * Serves the raw AES-128 key (16 bytes) for the requested track.
 * Authorized by bearer session OR a valid `?t=` stream token bound to this track.
 * The key is NEVER cached client-side.
 *
 * Guards (in order):
 *  1. ObjectId validation — 400 for malformed trackId.
 *  2. Auth — 401 if neither bearer nor valid bound token.
 *  3. Track existence — 404 if not found.
 *  4. Track availability — 403 if unavailable or copyright-removed.
 *  5. Key existence — 404 if TrackKey not yet persisted (ingest not complete).
 *  6. 200 with raw 16-byte key body, no-store.
 */
export async function getStreamKey(req: AuthRequest, res: Response): Promise<void> {
  const trackId = Array.isArray(req.params.trackId)
    ? req.params.trackId[0]
    : req.params.trackId;

  if (!trackId || !mongoose.Types.ObjectId.isValid(trackId)) {
    res.status(400).json({ error: 'Invalid track ID' });
    return;
  }

  if (!authorizeStreamRequest(req, trackId).ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const track = await TrackModel.findById(trackId).lean();
  if (!track) {
    res.status(404).json({ error: 'Track not found' });
    return;
  }

  if (!isTrackPlayable(track)) {
    res.status(403).json({ error: 'Track unavailable' });
    return;
  }

  const trackKey = await TrackKeyModel.findOne({ trackId }).lean();
  if (!trackKey) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }

  res.set('Content-Type', CONTENT_TYPE_OCTET_STREAM);
  res.set('Cache-Control', CACHE_CONTROL_NO_STORE);
  res.status(200).send(Buffer.from(trackKey.keyHex, 'hex'));
}

// ── Manifest helpers ──────────────────────────────────────────────────────────

/**
 * Extract or mint a stream token for manifest sub-requests.
 * Reuses `?t=` when present (token-only requests from native players);
 * otherwise mints a fresh one from the bearer session.
 */
function resolveToken(req: AuthRequest, trackId: string): string {
  const rawToken = req.query?.t;
  if (typeof rawToken === 'string' && rawToken) return rawToken;
  // Bearer path — user is guaranteed present (authorizeStreamRequest already passed)
  return mintStreamToken(
    { trackId, userId: req.user?.id ?? '' },
    STREAM_SESSION_TTL_SEC,
  );
}

// ── Master playlist ───────────────────────────────────────────────────────────

/**
 * GET /api/stream/:trackId/master.m3u8
 *
 * Serves the rewritten HLS master playlist. Variant paths are replaced with
 * tokenized API URLs; native players do not need a bearer header for sub-requests.
 *
 * Phase-5 seam: entitlement-based variant filtering is handled in
 * `buildMasterPlaylist` before the rewrite step.
 *
 * Guards: ObjectId(1) → auth(2) → track(3) → availability(4) → readiness(5) → 200.
 */
export async function getMasterPlaylist(req: AuthRequest, res: Response): Promise<void> {
  const trackId = Array.isArray(req.params.trackId)
    ? req.params.trackId[0]
    : req.params.trackId;

  if (!trackId || !mongoose.Types.ObjectId.isValid(trackId)) {
    res.status(400).json({ error: 'Invalid track ID' });
    return;
  }

  if (!authorizeStreamRequest(req, trackId).ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const track = await TrackModel.findById(trackId);
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

  if (!track.hlsMasterKey || !track.hls?.length) {
    res.status(404).json({ error: 'Master playlist not available' });
    return;
  }

  const token = resolveToken(req, trackId);
  const baseUrl = process.env.STREAM_KEY_BASE_URL ?? '';

  const playlist = await buildMasterPlaylist(track, token, baseUrl);
  res.set('Content-Type', CONTENT_TYPE_HLS_PLAYLIST);
  res.set('Cache-Control', CACHE_CONTROL_NO_STORE);
  res.status(200).send(playlist);
}

// ── Variant playlist ──────────────────────────────────────────────────────────

/**
 * GET /api/stream/:trackId/v/:variant
 *
 * Serves a rewritten variant playlist. `:variant` is e.g. `96.m3u8`.
 * Segments are presigned for 6 hours; the EXT-X-KEY URI is tokenized.
 *
 * Guards: ObjectId(1) → auth(2) → track(3) → availability(4) → readiness(5) →
 *         variant parse(6) → 200.
 */
export async function getVariantPlaylist(req: AuthRequest, res: Response): Promise<void> {
  const trackId = Array.isArray(req.params.trackId)
    ? req.params.trackId[0]
    : req.params.trackId;

  if (!trackId || !mongoose.Types.ObjectId.isValid(trackId)) {
    res.status(400).json({ error: 'Invalid track ID' });
    return;
  }

  if (!authorizeStreamRequest(req, trackId).ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const track = await TrackModel.findById(trackId);
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

  if (!track.hls?.length) {
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

  const rendition = track.hls.find((r) => r.bitrateKbps === bitrateKbps);
  if (!rendition) {
    res.status(404).json({ error: `No rendition at ${bitrateKbps} kbps` });
    return;
  }

  const token = resolveToken(req, trackId);
  const baseUrl = process.env.STREAM_KEY_BASE_URL ?? '';

  const playlist = await buildVariantPlaylist(track, bitrateKbps, token, baseUrl);
  res.set('Content-Type', CONTENT_TYPE_HLS_PLAYLIST);
  res.set('Cache-Control', CACHE_CONTROL_NO_STORE);
  res.status(200).send(playlist);
}
