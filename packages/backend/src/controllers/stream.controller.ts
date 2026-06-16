import mongoose from 'mongoose';
import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { TrackModel } from '../models/Track';
import { TrackKeyModel } from '../models/TrackKey';
import { UserMusicPreferencesModel } from '../models/UserMusicPreferences';
import { mintStreamToken, verifyStreamToken } from '../services/stream/streamToken';
import { buildMasterPlaylist, buildVariantPlaylist } from '../services/stream/manifestService';
import { getUserEntitlement } from '../services/premium/entitlement';
import { computeMaxBitrateKbps } from '../services/stream/audioQuality';

const CONTENT_TYPE_OCTET_STREAM = 'application/octet-stream';
const CONTENT_TYPE_HLS_PLAYLIST = 'application/vnd.apple.mpegurl';
const CACHE_CONTROL_NO_STORE = 'no-store';

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
      UserMusicPreferencesModel.findOne({ oxyUserId: req.user.id }).lean(),
    ]);
    const maxBitrateKbps = computeMaxBitrateKbps(
      { audioQuality: prefs?.audioQuality, dataSaver: prefs?.dataSaver },
      entitlement,
    );
    return { ok: true, maxBitrateKbps };
  }

  return { ok: false };
}

// ── Track availability guard ──────────────────────────────────────────────────

export function isTrackPlayable(track: { isAvailable?: boolean; copyrightRemoved?: boolean }): boolean {
  return track.isAvailable !== false && !track.copyrightRemoved;
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
 *   - Audius:  { url, type: 'audius', expiresAt }
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
    res.status(200).json({ url: track.streamUrl, type: 'audius', expiresAt: null });
    return;
  }

  // ── HLS branch ────────────────────────────────────────────────────────────
  if (track.status === 'processing') {
    res.status(409).json({ error: 'Track processing' });
    return;
  }

  if (track.status === 'ready' && track.hlsMasterKey && track.hls?.length) {
    const [entitlement, prefs] = await Promise.all([
      getUserEntitlement(req.user.id),
      UserMusicPreferencesModel.findOne({ oxyUserId: req.user.id }).lean(),
    ]);
    const maxBitrateKbps = computeMaxBitrateKbps(
      { audioQuality: prefs?.audioQuality, dataSaver: prefs?.dataSaver },
      entitlement,
    );
    const token = mintStreamToken(
      { trackId, userId: req.user.id, maxBitrateKbps },
      STREAM_SESSION_TTL_SEC,
    );
    const base = process.env.STREAM_KEY_BASE_URL ?? '';
    const url = `${base}/api/stream/${trackId}/master.m3u8?t=${token}`;
    const expiresAt = new Date(Date.now() + STREAM_SESSION_TTL_SEC * 1000).toISOString();

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

  if (!trackId || !mongoose.Types.ObjectId.isValid(trackId)) {
    res.status(400).json({ error: 'Invalid track ID' });
    return;
  }

  const access = await resolveStreamAccess(req, trackId);
  if (!access.ok) {
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

  if (!trackId || !mongoose.Types.ObjectId.isValid(trackId)) {
    res.status(400).json({ error: 'Invalid track ID' });
    return;
  }

  const access = await resolveStreamAccess(req, trackId);
  if (!access.ok) {
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

  const maxBitrateKbps = access.maxBitrateKbps;
  const baseUrl = process.env.STREAM_KEY_BASE_URL ?? '';
  const token = resolveManifestToken(req, trackId, maxBitrateKbps);

  const playlist = await buildMasterPlaylist(track, token, baseUrl, maxBitrateKbps);
  res.set('Content-Type', CONTENT_TYPE_HLS_PLAYLIST);
  res.set('Cache-Control', CACHE_CONTROL_NO_STORE);
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

  if (!trackId || !mongoose.Types.ObjectId.isValid(trackId)) {
    res.status(400).json({ error: 'Invalid track ID' });
    return;
  }

  const access = await resolveStreamAccess(req, trackId);
  if (!access.ok) {
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

  // Server-side cap enforcement: reject requests above the entitlement cap.
  // access.maxBitrateKbps is always a number when ok is true.
  if (bitrateKbps > access.maxBitrateKbps) {
    res.status(403).json({ error: 'Quality not permitted' });
    return;
  }

  const baseUrl = process.env.STREAM_KEY_BASE_URL ?? '';
  const token = resolveManifestToken(req, trackId, access.maxBitrateKbps);

  const playlist = await buildVariantPlaylist(track, bitrateKbps, token, baseUrl);
  res.set('Content-Type', CONTENT_TYPE_HLS_PLAYLIST);
  res.set('Cache-Control', CACHE_CONTROL_NO_STORE);
  res.status(200).send(playlist);
}
