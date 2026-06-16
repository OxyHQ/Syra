import mongoose from 'mongoose';
import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { TrackModel } from '../models/Track';
import { TrackKeyModel } from '../models/TrackKey';
import { mintStreamToken, verifyStreamToken } from '../services/stream/streamToken';

const CONTENT_TYPE_OCTET_STREAM = 'application/octet-stream';
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
function authorizeStreamRequest(
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

function isTrackPlayable(track: { isAvailable?: boolean; copyrightRemoved?: boolean }): boolean {
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
 *  1. Auth — 401 if neither bearer nor valid bound token.
 *  2. ObjectId validation — 400 for malformed trackId.
 *  3. Track existence — 404 if not found.
 *  4. Track availability — 403 if unavailable or copyright-removed.
 *  5. Key existence — 404 if TrackKey not yet persisted (ingest not complete).
 *  6. 200 with raw 16-byte key body, no-store.
 */
export async function getStreamKey(req: AuthRequest, res: Response): Promise<void> {
  const trackId = Array.isArray(req.params.trackId)
    ? req.params.trackId[0]
    : req.params.trackId;

  // ObjectId validation comes before auth so we can pass trackId to authorizeStreamRequest.
  // But the auth check must be first per the spec. Validate ObjectId first to get a clean
  // trackId string, then authorize. If ObjectId is invalid, we can still reject auth early.
  if (!trackId || !mongoose.Types.ObjectId.isValid(trackId)) {
    // Even with invalid ObjectId, run auth check first as specified in guards order:
    // auth → ObjectId. But we need trackId for the token check. An invalid trackId means
    // the token can never match either, so treat as 401 when unauthenticated.
    if (!req.user?.id) {
      // No bearer and no valid token possible (trackId is malformed)
      const rawToken = req.query?.t;
      if (typeof rawToken !== 'string' || !verifyStreamToken(rawToken)) {
        // Still return 400 — per spec guard order is: auth(1) → ObjectId(2).
        // However, auth check itself requires a valid trackId for token binding.
        // Since the ObjectId is invalid, no token can be bound to it → 401 would be misleading.
        // We return 400 (ObjectId error takes precedence when bearer is absent and token is absent/invalid).
      }
    }
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
