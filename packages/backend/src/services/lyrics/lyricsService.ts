import { asc, eq } from 'drizzle-orm';
import type { Lyrics, LyricsLine, LyricsQuery } from '@syra/shared-types';
import { getDb } from '../../db/postgres';
import { lyrics, lyricsLines, tracks } from '../../db/schema/catalog';
import type { LyricsProvider } from './LyricsProvider';
import { LrclibProvider } from './LrclibProvider';

/**
 * Read a track's cached lyrics, lines included and in order.
 *
 * `lines` is a child table now (`lyrics_lines`), not an embedded array, so the
 * ORDER BY is what makes the rendered lyric legible — `position` preserves the
 * order the provider returned, and without it Postgres is free to hand back the
 * lines of a song in any order at all.
 */
async function readCachedLyrics(trackId: string): Promise<Lyrics | null> {
  const [row] = await getDb()
    .select({
      id: lyrics.id,
      trackId: lyrics.trackId,
      synced: lyrics.synced,
      plain: lyrics.plain,
      source: lyrics.source,
      updatedAt: lyrics.updatedAt,
    })
    .from(lyrics)
    .where(eq(lyrics.trackId, trackId))
    .limit(1);

  if (!row) return null;

  const lines = await getDb()
    .select({ timeMs: lyricsLines.timeMs, text: lyricsLines.text })
    .from(lyricsLines)
    .where(eq(lyricsLines.lyricsId, row.id))
    .orderBy(asc(lyricsLines.position));

  return {
    trackId: row.trackId,
    synced: row.synced,
    lines,
    plain: row.plain ?? undefined,
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Persist a provider result for a track, replacing whatever was cached.
 *
 * ONE transaction, because the lyric and its lines are one fact: a partial
 * write would leave a lyric row whose lines belong to an older fetch, and that
 * is not distinguishable afterwards from a song that legitimately changed.
 *
 * The upsert is what makes a concurrent duplicate fetch safe — `lyrics.track_id`
 * is unique, so the loser of a race updates rather than failing — and the line
 * delete-then-insert is what makes it IDEMPOTENT: `lyrics_lines` has no natural
 * key beyond `(lyrics_id, position)`, so appending would silently accumulate a
 * second copy of every line on the second fetch.
 */
async function cacheLyrics(
  trackId: string,
  result: { synced: boolean; lines: LyricsLine[]; plain?: string; source: string }
): Promise<Lyrics> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .insert(lyrics)
      .values({
        trackId,
        synced: result.synced,
        plain: result.plain,
        source: result.source,
      })
      .onConflictDoUpdate({
        target: lyrics.trackId,
        set: { synced: result.synced, plain: result.plain ?? null, source: result.source },
      })
      .returning({ id: lyrics.id, updatedAt: lyrics.updatedAt });

    if (!row) {
      throw new Error(`Failed to persist lyrics for track ${trackId}`);
    }

    await tx.delete(lyricsLines).where(eq(lyricsLines.lyricsId, row.id));

    if (result.lines.length > 0) {
      await tx.insert(lyricsLines).values(
        result.lines.map((line, position) => ({
          lyricsId: row.id,
          position,
          timeMs: line.timeMs,
          text: line.text,
        }))
      );
    }

    return {
      trackId,
      synced: result.synced,
      lines: result.lines,
      plain: result.plain,
      source: result.source,
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

/**
 * Fetch lyrics for a track, with a database cache layer.
 *
 * Cache hit  → return the cached rows immediately; provider is not called.
 * Cache miss → look up the track, query the provider, persist the result,
 *              and return it. Negative results (provider returns null) are
 *              NOT cached so a later re-run can pick up newly-added lyrics.
 *
 * @param trackId  The `tracks.id` to fetch lyrics for.
 * @param provider Lyrics provider to call on a cache miss (default: LrclibProvider).
 * @returns        Lyrics or null if the track doesn't exist / provider has none.
 */
export async function getLyricsForTrack(
  trackId: string,
  provider?: LyricsProvider,
): Promise<Lyrics | null> {
  const cached = await readCachedLyrics(trackId);
  if (cached) return cached;

  // Resolve the track to build the query.
  const [track] = await getDb()
    .select({
      title: tracks.title,
      artistName: tracks.artistName,
      albumName: tracks.albumName,
      duration: tracks.duration,
    })
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);

  if (!track) return null;

  const query: LyricsQuery = {
    trackName: track.title,
    artistName: track.artistName,
    albumName: track.albumName ?? undefined,
    durationSec: track.duration,
  };

  const lyricsProvider = provider ?? new LrclibProvider();
  const result = await lyricsProvider.getLyrics(query);
  if (!result) return null;

  return cacheLyrics(trackId, result);
}
