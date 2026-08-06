/**
 * `db/catalog/genres.ts` — the write side of the genre taxonomy.
 *
 * It had no test file at all until the Task 10b review, and the defect that
 * found is the reason every case below exists: the module de-duplicated its
 * INPUT case-insensitively while `genres` was unique on the exact `(name, kind)`,
 * so `['Rock']` then `['rock']` created two rows and the album linked to the
 * duplicate — the "three cards for one genre" outcome the module's own comment
 * said it prevented.
 *
 * ## Every fixture sits on BOTH sides of the case distinction
 *
 * This is the rule this branch keeps relearning: a suite that only ever feeds
 * `'Rock'` cannot tell a case-sensitive implementation from a case-insensitive
 * one — every assertion passes either way. So the cases below deliberately mix
 * spellings ACROSS calls, not just within one, because within-one-call
 * de-duplication is the half that already worked.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { albumGenres, albums, catalogEntities, imageAssets } from '../../schema/catalog';
import { genres } from '../../schema/genres';
import { albumGenreNames, resolveMusicGenreIds, setAlbumGenres } from '../genres';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

/** Every `genres` row's name, for asserting how many exist and how they read. */
async function storedNames(): Promise<string[]> {
  const rows = await getDb().select({ name: genres.name }).from(genres);
  return rows.map((row) => row.name).sort();
}

async function makeAlbum(): Promise<string> {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: `Genre Artist ${suffix}`,
      nameKey: `genre-artist-${suffix}`,
      source: 'upload',
    })
    .returning({ id: catalogEntities.id });

  const [asset] = await getDb()
    .insert(imageAssets)
    .values({
      s3Key: `fixtures/${suffix}.jpg`,
      filename: 'c.jpg',
      contentType: 'image/jpeg',
      byteSize: 1,
      ownerType: 'album',
    })
    .returning({ id: imageAssets.id });

  const [album] = await getDb()
    .insert(albums)
    .values({
      title: `Album ${suffix}`,
      artistId: artist?.id ?? '',
      artistName: 'Genre Artist',
      releaseDate: '2024-01-01',
      coverArtId: asset?.id ?? '',
      source: 'upload',
    })
    .returning({ id: albums.id });

  if (!album) throw new Error('makeAlbum: insert returned no row');
  return album.id;
}

describe('resolveMusicGenreIds — one row per genre, whatever the spelling', () => {
  it('collapses spellings within a single call', async () => {
    const ids = await resolveMusicGenreIds(getDb(), ['Rock', 'rock', ' Rock ', 'ROCK']);

    expect(ids).toHaveLength(1);
    // The FIRST spelling wins the row: the stored case is what the browse
    // surface renders, so it must not be silently lowercased.
    expect(await storedNames()).toEqual(['Rock']);
  });

  /**
   * THE CASE THE REVIEW FOUND. Everything above passes against a case-sensitive
   * constraint too, because within-call de-duplication never touched the
   * database. This is the one that fails without `genres_lower_name_kind_key`
   * and the `lower()` read-back.
   */
  it('collapses spellings ACROSS calls, returning the SAME id', async () => {
    const [first] = await resolveMusicGenreIds(getDb(), ['Rock']);
    const [second] = await resolveMusicGenreIds(getDb(), ['rock', ' Rock ']);

    expect(await storedNames()).toEqual(['Rock']);
    expect(`first=${first} second=${second}`).toBe(`first=${first} second=${first}`);
  });

  it('resolves a genre that exists only under a DIFFERENT case', async () => {
    // The exact-match read-back returned nothing for this, which is how the
    // duplicate came to be inserted rather than merely looked up.
    await resolveMusicGenreIds(getDb(), ['Drum & Bass']);
    const ids = await resolveMusicGenreIds(getDb(), ['drum & bass']);

    expect(ids).toHaveLength(1);
    expect(await storedNames()).toEqual(['Drum & Bass']);
  });

  it('keeps genuinely different genres apart', async () => {
    // The vacuity floor for every collapse above: an implementation that
    // returned one id for everything would satisfy them all.
    const ids = await resolveMusicGenreIds(getDb(), ['Rock', 'Jazz', 'Ambient']);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(await storedNames()).toEqual(['Ambient', 'Jazz', 'Rock']);
  });

  it('drops blanks and whitespace-only entries rather than storing them', async () => {
    expect(await resolveMusicGenreIds(getDb(), ['', '   ', '\t'])).toEqual([]);
    expect(await storedNames()).toEqual([]);
  });

  it('issues no query at all for an empty list', async () => {
    // `inArray(col, [])` and a zero-row `insert().values([])` are both errors in
    // Postgres, so the early return is load-bearing rather than an optimisation.
    expect(await resolveMusicGenreIds(getDb(), [])).toEqual([]);
  });

  /**
   * `genres` serves two verticals and `album_genres` carries a COMPOSITE foreign
   * key to `(genres.id, genres.kind)` precisely so a music junction cannot point
   * at a podcast category. This asserts the write side keeps its half of that.
   */
  it('writes music genres only, never touching a podcast category of the same name', async () => {
    const [podcastComedy] = await getDb()
      .insert(genres)
      .values({ name: 'Comedy', kind: 'podcast' })
      .returning({ id: genres.id });

    const [musicComedy] = await resolveMusicGenreIds(getDb(), ['comedy']);

    expect(musicComedy).not.toBe(podcastComedy?.id);
    expect(await storedNames()).toEqual(['Comedy', 'comedy']);
  });
});

describe('setAlbumGenres — replaces, never appends', () => {
  it('links an album to its genres and reads them back', async () => {
    const albumId = await makeAlbum();
    await setAlbumGenres(getDb(), albumId, ['Rock', 'Jazz']);

    expect((await albumGenreNames(albumId)).sort()).toEqual(['Jazz', 'Rock']);
  });

  it('a second call replaces the links rather than accumulating them', async () => {
    const albumId = await makeAlbum();
    await setAlbumGenres(getDb(), albumId, ['Rock', 'Jazz']);
    await setAlbumGenres(getDb(), albumId, ['Ambient']);

    expect(await albumGenreNames(albumId)).toEqual(['Ambient']);
    const links = await getDb()
      .select({ id: albumGenres.id })
      .from(albumGenres)
      .where(eq(albumGenres.albumId, albumId));
    expect(links).toHaveLength(1);
  });

  it('re-linking the SAME genre under a different spelling does not fail the unique link', async () => {
    // `album_genres` is unique on `(album_id, genre_id)`. Without the
    // case-insensitive resolution above, the second call would resolve `rock` to
    // a NEW genre row and quietly leave the album on two "Rock" links.
    const albumId = await makeAlbum();
    await setAlbumGenres(getDb(), albumId, ['Rock']);
    await setAlbumGenres(getDb(), albumId, ['rock']);

    expect(await albumGenreNames(albumId)).toEqual(['Rock']);
    expect(await storedNames()).toEqual(['Rock']);
  });

  it('clears every link when given no genres', async () => {
    const albumId = await makeAlbum();
    await setAlbumGenres(getDb(), albumId, ['Rock']);
    await setAlbumGenres(getDb(), albumId, []);

    expect(await albumGenreNames(albumId)).toEqual([]);
  });
});
