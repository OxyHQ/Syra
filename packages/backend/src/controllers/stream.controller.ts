import mongoose from 'mongoose';
import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { getAuthenticatedUserId } from '../utils/auth';
import { TrackModel } from '../models/Track';
import { TrackKeyModel } from '../models/TrackKey';

const CONTENT_TYPE_OCTET_STREAM = 'application/octet-stream';
const CACHE_CONTROL_NO_STORE = 'no-store';

/**
 * GET /api/stream/:trackId/key
 *
 * Serves the raw AES-128 key (16 bytes) for the requested track.
 * Requires authentication. The key is NEVER cached client-side.
 *
 * Guards (in order):
 *  1. Auth check — 401 if not authenticated.
 *  2. ObjectId validation — 400 for malformed trackId.
 *  3. Track existence — 404 if not found.
 *  4. Track availability — 403 if unavailable or copyright-removed.
 *  5. Key existence — 404 if TrackKey not yet persisted (ingest not complete).
 *  6. 200 with raw 16-byte key body.
 */
export async function getStreamKey(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
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

  if (!track.isAvailable || track.copyrightRemoved) {
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
