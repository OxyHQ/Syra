/**
 * `--link` — pointing an already-written credit at the artist it names.
 *
 * ## The bug this exists for
 *
 * The split writes a featured credit carrying the new artist's id. When a
 * credit for that person ALREADY existed it skipped the row entirely, on the
 * assumption that finding one meant it was correct — the same assumption the
 * denormalised counters made, and wrong for the same reason. Production ran an
 * earlier pass that wrote the credit without an id, the later pass skipped it,
 * and the guest ended up named on the track and linked to nobody. The merged
 * row was already deleted by then, so re-running the split could not repair it:
 * there was nothing left to split.
 *
 * ## Why the fixtures look the way they do
 *
 * The distinction `link` exists to make is between a credit with NO id and one
 * that already has one, so every case needs both present — a fixture set where
 * every credit is unlinked cannot tell "fills the empty ones" from "overwrites
 * everything", which is the failure that would silently re-point a credit
 * somebody had a reason to link elsewhere.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities, trackCredits, tracks } from '../db/schema/catalog';
import { link } from './splitMergedArtist';

beforeAll(async () => {
  await connectDb();
});
afterEach(async () => {
  await clearDb();
});
afterAll(async () => {
  await disconnectDb();
});

async function makeArtist(name: string, nameKey: string): Promise<string> {
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({ type: 'artist', name, nameKey, source: 'upload' })
    .returning({ id: catalogEntities.id });
  if (!artist) throw new Error('makeArtist: insert returned no row');
  return artist.id;
}

async function makeTrack(title: string, artistId: string): Promise<string> {
  const [track] = await getDb()
    .insert(tracks)
    .values({ title, artistId, artistName: 'principal', duration: 100, source: 'upload', status: 'ready' })
    .returning({ id: tracks.id });
  if (!track) throw new Error('makeTrack: insert returned no row');
  return track.id;
}

async function readCredit(id: string) {
  const [row] = await getDb().select().from(trackCredits).where(eq(trackCredits.id, id));
  if (!row) throw new Error('readCredit: no row');
  return row;
}

async function makeCredit(
  trackId: string,
  name: string,
  nameKey: string,
  catalogEntityId?: string
): Promise<string> {
  const [credit] = await getDb()
    .insert(trackCredits)
    .values({ trackId, position: 0, name, nameKey, role: 'artist', catalogEntityId })
    .returning({ id: trackCredits.id });
  if (!credit) throw new Error('makeCredit: insert returned no row');
  return credit.id;
}

describe('splitMergedArtist --link', () => {
  it('fills an empty entity id and leaves an existing one alone', async () => {
    const principal = await makeArtist('benny blanco', 'benny-blanco');
    const guest = await makeArtist('Bb trickz', 'bb trickz');
    const other = await makeArtist('Otra persona', 'otra-persona');

    const first = await makeTrack('Joven y Salvaje', principal);
    const second = await makeTrack('Otro tema', principal);

    const unlinked = await makeCredit(first, 'Bb trickz', 'bb trickz');
    // Same name key, already pointing somewhere else on purpose. If `link`
    // overwrote it the test would still pass with an `isNull` filter missing,
    // which is exactly why this row is here.
    const alreadyLinked = await makeCredit(second, 'Bb trickz', 'bb trickz', other);

    await link('Bb trickz');

    expect((await readCredit(unlinked)).catalogEntityId).toBe(guest);
    expect((await readCredit(alreadyLinked)).catalogEntityId).toBe(other);
  });

  it('matches on the normalised key, not the literal name it was written with', async () => {
    const principal = await makeArtist('Principal', 'principal');
    const guest = await makeArtist('Bb trickz', 'bb trickz');
    const trackId = await makeTrack('Un tema', principal);
    const credit = await makeCredit(trackId, 'bb  TRICKZ', 'bb trickz');

    // Called with yet another spelling: all three normalise to one key.
    await link('BB Trickz');

    expect((await readCredit(credit)).catalogEntityId).toBe(guest);
  });

  it('leaves a credit for a DIFFERENT person untouched', async () => {
    const principal = await makeArtist('Principal', 'principal');
    await makeArtist('Bb trickz', 'bb trickz');
    const trackId = await makeTrack('Un tema', principal);
    const otherCredit = await makeCredit(trackId, 'Ana Gil', 'ana gil');

    await link('Bb trickz');

    expect((await readCredit(otherCredit)).catalogEntityId).toBeNull();
  });

  it('refuses to invent an artist that does not exist', async () => {
    // Failing closed matters more here than convenience: creating the row on
    // demand would let a typo mint a second artist and link real credits to it.
    await expect(link('Nadie En Absoluto')).rejects.toThrow(/No artist with name key/);
  });

  it('is a no-op the second time', async () => {
    const principal = await makeArtist('Principal', 'principal');
    const guest = await makeArtist('Bb trickz', 'bb trickz');
    const trackId = await makeTrack('Un tema', principal);
    const credit = await makeCredit(trackId, 'Bb trickz', 'bb trickz');

    await link('Bb trickz');
    await link('Bb trickz');

    expect((await readCredit(credit)).catalogEntityId).toBe(guest);
  });
});
