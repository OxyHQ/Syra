import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { getLyricsForTrack } from '../services/lyrics/lyricsService';
import { getParam } from '../utils/reqParams';

/** Cache-Control max-age for publicly-served lyrics (1 hour). */
const LYRICS_CACHE_MAX_AGE = 3600;

/**
 * GET /api/lyrics/:trackId
 *
 * Public endpoint — returns cached or freshly-fetched lyrics for the given
 * track. Lyrics are fetched from LRCLIB on first miss and cached in MongoDB.
 *
 * Responses:
 *  200 — lyrics found (cached or freshly fetched).
 *  400 — trackId is not a valid ObjectId.
 *  404 — no lyrics found for this track.
 */
export async function getLyrics(req: Request, res: Response): Promise<void> {
  const trackId = getParam(req, 'trackId');

  if (!mongoose.Types.ObjectId.isValid(trackId)) {
    res.status(400).json({ error: 'Invalid trackId' });
    return;
  }

  const lyrics = await getLyricsForTrack(trackId);

  if (!lyrics) {
    res.status(404).json({ error: 'Lyrics not found' });
    return;
  }

  res
    .set('Cache-Control', `public, max-age=${LYRICS_CACHE_MAX_AGE}`)
    .json(lyrics);
}
