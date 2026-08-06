import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { count, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { catalogEntities, lyrics, lyricsLines, tracks } from '../../db/schema/catalog';
import { getLyricsForTrack } from './lyricsService';
import type { LyricsProvider } from './LyricsProvider';
import type { Lyrics } from '@syra/shared-types';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

/**
 * Minted per test rather than once at module load: `tracks.id` is a real
 * primary key and `lyrics.track_id` a real foreign key, so the id has to be
 * unique across a run that truncates between tests but keeps the module alive.
 */
let TRACK_ID = '';

async function lyricsCount(trackId?: string): Promise<number> {
  const query = getDb().select({ total: count() }).from(lyrics);
  const [row] = trackId ? await query.where(eq(lyrics.trackId, trackId)) : await query;
  return row?.total ?? 0;
}

// ── Fake provider helpers ─────────────────────────────────────────────────────

function makeProvider(
  result: Omit<Lyrics, 'trackId' | 'updatedAt'> | null,
): LyricsProvider & { callCount: number; lastQuery: unknown } {
  const p = {
    source: 'lrclib',
    callCount: 0,
    lastQuery: null as unknown,
    async getLyrics(query: unknown) {
      p.callCount += 1;
      p.lastQuery = query;
      return result;
    },
  };
  return p as LyricsProvider & { callCount: number; lastQuery: unknown };
}

function throwingProvider(): LyricsProvider {
  return {
    source: 'lrclib',
    async getLyrics() { throw new Error('provider should not be called'); },
  };
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

/**
 * Cached lyrics AND their lines. The lines are a child table now, so a fixture
 * that wrote only the parent would make the cache-hit test pass while asserting
 * nothing about the ordering the reader depends on.
 */
async function seedCachedLyrics(trackId: string): Promise<void> {
  await seedTrack(trackId);
  const [row] = await getDb()
    .insert(lyrics)
    .values({ trackId, synced: true, source: 'lrclib' })
    .returning({ id: lyrics.id });
  if (!row) throw new Error('seedCachedLyrics: insert returned no row');

  await getDb()
    .insert(lyricsLines)
    .values({ lyricsId: row.id, position: 0, timeMs: 1000, text: 'cached line' });
}

/** A track, and the artist `tracks.artist_id` now really references. */
async function seedTrack(trackId: string): Promise<void> {
  const [existing] = await getDb()
    .select({ id: tracks.id })
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);
  if (existing) return;

  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: 'Free Artist',
      nameKey: `free-artist-${suffix}`,
      source: 'cc',
    })
    .returning({ id: catalogEntities.id });

  await getDb().insert(tracks).values({
    id: trackId,
    title: 'Open Road',
    artistName: 'Free Artist',
    artistId: artist?.id ?? '',
    duration: 210,
    albumName: 'Open Album',
    source: 'cc',
    status: 'ready',
    isExplicit: false,
    isAvailable: true,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  TRACK_ID = uuidv7();
});

describe('getLyricsForTrack — cache hit', () => {
  it('returns cached doc without invoking the provider', async () => {
    await seedCachedLyrics(TRACK_ID);

    const provider = throwingProvider();
    const result = await getLyricsForTrack(TRACK_ID, provider);

    expect(result).not.toBeNull();
    expect(result?.trackId).toBe(TRACK_ID);
    expect(result?.lines[0].text).toBe('cached line');
  });
});

describe('getLyricsForTrack — cache miss', () => {
  it('fetches from provider, persists a Lyrics doc, and returns it', async () => {
    await seedTrack(TRACK_ID);

    const provider = makeProvider({
      synced: true,
      lines: [{ timeMs: 0, text: 'hi' }],
      source: 'lrclib',
    });

    const result = await getLyricsForTrack(TRACK_ID, provider);

    expect(result).not.toBeNull();
    expect(result?.trackId).toBe(TRACK_ID);
    expect(result?.synced).toBe(true);
    expect(result?.lines[0].text).toBe('hi');
    expect(result?.source).toBe('lrclib');

    // Exactly one doc persisted
    expect(await lyricsCount(TRACK_ID)).toBe(1);
  });

  it('passes trackName, artistName, albumName, durationSec from the track to the provider', async () => {
    await seedTrack(TRACK_ID);

    const provider = makeProvider({
      synced: false,
      lines: [],
      source: 'lrclib',
    });

    await getLyricsForTrack(TRACK_ID, provider);

    expect(provider.callCount).toBe(1);
    const q = provider.lastQuery as Record<string, unknown>;
    expect(q.trackName).toBe('Open Road');
    expect(q.artistName).toBe('Free Artist');
    expect(q.albumName).toBe('Open Album');
    expect(q.durationSec).toBe(210);
  });

  it('returns null and creates no doc when track does not exist', async () => {
    const provider = throwingProvider();
    const result = await getLyricsForTrack(TRACK_ID, provider);

    expect(result).toBeNull();
    expect(await lyricsCount()).toBe(0);
  });

  it('returns null and creates no doc when provider returns null (no lyrics found)', async () => {
    await seedTrack(TRACK_ID);

    const provider = makeProvider(null);
    const result = await getLyricsForTrack(TRACK_ID, provider);

    expect(result).toBeNull();
    expect(await lyricsCount()).toBe(0);
  });

  it('re-running with same trackId hits cache on second call (upsert dedup)', async () => {
    await seedTrack(TRACK_ID);

    const provider = makeProvider({ synced: false, lines: [], source: 'lrclib' });
    await getLyricsForTrack(TRACK_ID, provider);
    await getLyricsForTrack(TRACK_ID, provider); // second call should hit cache

    expect(provider.callCount).toBe(1); // provider only called once
    expect(await lyricsCount(TRACK_ID)).toBe(1);
  });
});

/**
 * `lines` is a child table now, not an embedded array, so ORDER is a property
 * of the QUERY rather than of the document.
 *
 * The obvious version of this test does not work, and I wrote it first: fetch
 * through the provider, read back, assert the order. It passes with the
 * `ORDER BY` REMOVED — mutation-verified — because `cacheLyrics` inserts the
 * lines in array order, so physical row order already equals `position` order
 * and Postgres returns a three-row table in physical order.
 *
 * A fixture that cannot tell the two apart is worse than no test. So this one
 * writes the rows with their PHYSICAL order deliberately scrambled against
 * their `position`, which is the only shape where an unordered read and an
 * ordered read disagree.
 */
describe('getLyricsForTrack — line order survives the child table', () => {
  it('returns lines by position even when physical row order differs', async () => {
    await seedTrack(TRACK_ID);
    const [row] = await getDb()
      .insert(lyrics)
      .values({ trackId: TRACK_ID, synced: true, source: 'lrclib' })
      .returning({ id: lyrics.id });
    if (!row) throw new Error('expected a lyrics row');

    // Inserted 2, 0, 1 — so an unordered scan yields "third, first, second".
    await getDb().insert(lyricsLines).values([
      { lyricsId: row.id, position: 2, timeMs: 3000, text: 'third' },
      { lyricsId: row.id, position: 0, timeMs: 1000, text: 'first' },
      { lyricsId: row.id, position: 1, timeMs: 2000, text: 'second' },
    ]);

    const cached = await getLyricsForTrack(TRACK_ID, throwingProvider());

    expect(cached?.lines.map((line) => line.text)).toEqual(['first', 'second', 'third']);
  });

  it('caching writes one row per line, never a second copy', async () => {
    await seedTrack(TRACK_ID);
    await getLyricsForTrack(
      TRACK_ID,
      makeProvider({ synced: false, lines: [{ timeMs: 0, text: 'v1' }], source: 'lrclib' })
    );

    const [parent] = await getDb()
      .select({ id: lyrics.id })
      .from(lyrics)
      .where(eq(lyrics.trackId, TRACK_ID))
      .limit(1);
    const [lineCount] = await getDb()
      .select({ total: count() })
      .from(lyricsLines)
      .where(eq(lyricsLines.lyricsId, parent?.id ?? ''));

    expect(lineCount?.total).toBe(1);
  });
});
