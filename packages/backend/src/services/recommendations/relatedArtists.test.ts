import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { catalogEntities, tracks } from '../../db/schema/catalog';
import { catalogRelations } from '../../db/schema/user';
import { getRelatedArtists } from './recommendationService';

/**
 * `getRelatedArtists` is the ONE reader of the artist co-listen graph — both
 * `GET /api/artists/:id/related` and the artist profile screen go through it.
 *
 * These cover the playability gate specifically, because the three sources it
 * merges each exclude only `terminated`, which is a property of the ACCOUNT.
 * An artist whose tracks were taken down one by one, or a claimable stub created
 * from a stranger's file tags that has no tracks yet, is not terminated and used
 * to be offered as somewhere to go next — a shelf entry opening on an empty page.
 */

/**
 * One database. The catalogue and the co-listen graph this suite is about are
 * both Postgres since Task 15 moved `catalog_relations`; the Mongo hooks this
 * file used to carry alongside them are gone.
 */
beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

async function makeArtist(
  overrides: Partial<typeof catalogEntities.$inferInsert> = {}
): Promise<{ id: string }> {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: `Artist ${suffix}`,
      // Unique per fixture: `catalog_entities_artist_name_key_key` is a unique
      // partial index over artists.
      nameKey: `artist-${suffix}`,
      source: 'upload',
      ...overrides,
    })
    .returning({ id: catalogEntities.id });

  if (!artist) throw new Error('makeArtist: insert returned no row');
  return artist;
}

async function makeTrack(
  artistId: string,
  overrides: Partial<typeof tracks.$inferInsert> = {}
): Promise<void> {
  await getDb().insert(tracks).values({
    title: `Track ${uuidv7()}`,
    artistId,
    artistName: 'Someone',
    duration: 200,
    source: 'upload',
    status: 'ready',
    ...overrides,
  });
}

async function relate(sourceId: string, targetId: string, score: number) {
  await getDb().insert(catalogRelations).values({
    kind: 'artist', sourceId, targetId, score, coCount: 10, computedAt: new Date(),
  });
}

function ids(artists: { id: string }[]): string[] {
  return artists.map((artist) => artist.id);
}

describe('getRelatedArtists — only artists you can actually play', () => {
  it('returns a graph neighbour that has playable music', async () => {
    const seed = await makeArtist();
    const neighbour = await makeArtist();
    await makeTrack(neighbour.id);
    await relate(seed.id, neighbour.id, 0.9);

    const related = await getRelatedArtists(seed.id, 5);
    expect(ids(related)).toContain(neighbour.id);
  });

  it('drops a graph neighbour whose every track was taken down', async () => {
    const seed = await makeArtist();
    const silenced = await makeArtist();
    await makeTrack(silenced.id, { copyrightRemoved: true, isAvailable: false });
    await relate(seed.id, silenced.id, 0.9);

    expect(await getRelatedArtists(seed.id, 5)).toEqual([]);
  });

  /**
   * The case the contribution path creates in volume: a `claimable` stub exists
   * the moment somebody uploads a file naming an artist Syra has never heard of.
   * It is not terminated and it has nothing to play.
   */
  it('drops an artist with no tracks at all, including a claimable stub', async () => {
    const seed = await makeArtist();
    const stub = await makeArtist({ origin: 'contributed', claimable: true });
    await relate(seed.id, stub.id, 0.9);

    expect(await getRelatedArtists(seed.id, 5)).toEqual([]);
  });

  it('filters the GENRE fallback too, not just the graph', async () => {
    const seed = await makeArtist({ genres: ['shoegaze'] });
    await makeTrack(seed.id);
    const emptyPeer = await makeArtist({ genres: ['shoegaze'] });
    const playablePeer = await makeArtist({ genres: ['shoegaze'] });
    await makeTrack(playablePeer.id);

    const related = await getRelatedArtists(seed.id, 10);

    expect(ids(related)).toContain(playablePeer.id);
    expect(ids(related)).not.toContain(emptyPeer.id);
  });

  it('filters the POPULARITY fallback too', async () => {
    const seed = await makeArtist();
    await makeTrack(seed.id);
    const emptyButPopular = await makeArtist({ popularity: 99 });
    const playable = await makeArtist({ popularity: 1 });
    await makeTrack(playable.id);

    const related = await getRelatedArtists(seed.id, 10);

    expect(ids(related)).toContain(playable.id);
    expect(ids(related)).not.toContain(emptyButPopular.id);
  });

  /**
   * Vacuity floor. Every assertion above is an absence, so a `getRelatedArtists`
   * that returned nothing at all would satisfy them and prove nothing. This one
   * fails unless real results still come through.
   */
  it('still returns results — the filter narrows, it does not empty', async () => {
    const seed = await makeArtist({ genres: ['jazz'] });
    await makeTrack(seed.id);
    for (let i = 0; i < 3; i += 1) {
      const peer = await makeArtist({ genres: ['jazz'] });
      await makeTrack(peer.id);
    }

    const related = await getRelatedArtists(seed.id, 10);
    expect(related.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * The Mongo version rejected this with an `ObjectId.isValid` pre-check.
   * `catalog_entities.id` is `text`, so no guard is needed and none exists: the
   * query itself answers, which is why the assertion is unchanged even though
   * the mechanism behind it is gone.
   */
  it('returns nothing for an id no row carries', async () => {
    expect(await getRelatedArtists('not-an-id')).toEqual([]);
  });
});
