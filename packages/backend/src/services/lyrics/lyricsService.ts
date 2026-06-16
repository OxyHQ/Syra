import type { Lyrics, LyricsQuery } from '@syra/shared-types';
import { LyricsModel } from '../../models/Lyrics';
import { TrackModel } from '../../models/Track';
import type { LyricsProvider } from './LyricsProvider';
import { LrclibProvider } from './LrclibProvider';

/**
 * Fetch lyrics for a track, with a MongoDB cache layer.
 *
 * Cache hit  → return the cached doc immediately; provider is not called.
 * Cache miss → look up the track, query the provider, persist the result,
 *              and return it. Negative results (provider returns null) are
 *              NOT cached so a later re-run can pick up newly-added lyrics.
 *
 * @param trackId  MongoDB ObjectId string of the track.
 * @param provider Lyrics provider to call on a cache miss (default: LrclibProvider).
 * @returns        Lyrics or null if the track doesn't exist / provider has none.
 */
export async function getLyricsForTrack(
  trackId: string,
  provider?: LyricsProvider,
): Promise<Lyrics | null> {
  // Cache hit
  const cached = await LyricsModel.findOne({ trackId }).lean();
  if (cached) {
    return {
      trackId: cached.trackId,
      synced: cached.synced,
      lines: cached.lines,
      plain: cached.plain,
      source: cached.source,
      updatedAt: cached.updatedAt?.toISOString(),
    };
  }

  // Resolve the track to build the query
  const track = await TrackModel.findById(trackId).lean();
  if (!track) return null;

  const query: LyricsQuery = {
    trackName: track.title,
    artistName: track.artistName,
    albumName: track.albumName,
    durationSec: track.duration,
  };

  const lyricsProvider = provider ?? new LrclibProvider();
  const result = await lyricsProvider.getLyrics(query);
  if (!result) return null;

  // Persist (upsert guards against a concurrent duplicate write)
  const doc = await LyricsModel.findOneAndUpdate(
    { trackId },
    { trackId, ...result },
    { upsert: true, new: true },
  );

  return {
    trackId: doc.trackId,
    synced: doc.synced,
    lines: doc.lines,
    plain: doc.plain,
    source: doc.source,
    updatedAt: doc.updatedAt?.toISOString(),
  };
}
