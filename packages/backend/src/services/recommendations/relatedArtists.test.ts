import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../../test/mongo';
import { ArtistModel } from '../../models/CatalogEntity';
import { TrackModel } from '../../models/Track';
import { CatalogRelationModel } from '../../models/CatalogRelation';
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

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

async function makeArtist(overrides: Record<string, unknown> = {}) {
  return ArtistModel.create({
    name: `Artist ${Math.random().toString(36).slice(2)}`,
    source: 'upload',
    ...overrides,
  });
}

async function makeTrack(artistId: string, overrides: Record<string, unknown> = {}) {
  return TrackModel.create({
    title: `Track ${Math.random().toString(36).slice(2)}`,
    artistId,
    artistName: 'Someone',
    duration: 200,
    source: 'upload',
    status: 'ready',
    ...overrides,
  });
}

async function relate(sourceId: string, targetId: string, score: number) {
  await CatalogRelationModel.create({
    kind: 'artist', sourceId, targetId, score, coCount: 10, computedAt: new Date(),
  });
}

function ids(artists: { _id: { toString(): string } }[]): string[] {
  return artists.map((artist) => artist._id.toString());
}

describe('getRelatedArtists — only artists you can actually play', () => {
  it('returns a graph neighbour that has playable music', async () => {
    const seed = await makeArtist();
    const neighbour = await makeArtist();
    await makeTrack(neighbour._id.toString());
    await relate(seed._id.toString(), neighbour._id.toString(), 0.9);

    const related = await getRelatedArtists(seed._id.toString(), 5);
    expect(ids(related)).toContain(neighbour._id.toString());
  });

  it('drops a graph neighbour whose every track was taken down', async () => {
    const seed = await makeArtist();
    const silenced = await makeArtist();
    await makeTrack(silenced._id.toString(), { copyrightRemoved: true, isAvailable: false });
    await relate(seed._id.toString(), silenced._id.toString(), 0.9);

    expect(await getRelatedArtists(seed._id.toString(), 5)).toEqual([]);
  });

  /**
   * The case the contribution path creates in volume: a `claimable` stub exists
   * the moment somebody uploads a file naming an artist Syra has never heard of.
   * It is not terminated and it has nothing to play.
   */
  it('drops an artist with no tracks at all, including a claimable stub', async () => {
    const seed = await makeArtist();
    const stub = await makeArtist({ origin: 'contributed', claimable: true });
    await relate(seed._id.toString(), stub._id.toString(), 0.9);

    expect(await getRelatedArtists(seed._id.toString(), 5)).toEqual([]);
  });

  it('filters the GENRE fallback too, not just the graph', async () => {
    const seed = await makeArtist({ genres: ['shoegaze'] });
    await makeTrack(seed._id.toString());
    const emptyPeer = await makeArtist({ genres: ['shoegaze'] });
    const playablePeer = await makeArtist({ genres: ['shoegaze'] });
    await makeTrack(playablePeer._id.toString());

    const related = await getRelatedArtists(seed._id.toString(), 10);

    expect(ids(related)).toContain(playablePeer._id.toString());
    expect(ids(related)).not.toContain(emptyPeer._id.toString());
  });

  it('filters the POPULARITY fallback too', async () => {
    const seed = await makeArtist();
    await makeTrack(seed._id.toString());
    const emptyButPopular = await makeArtist({ popularity: 99 });
    const playable = await makeArtist({ popularity: 1 });
    await makeTrack(playable._id.toString());

    const related = await getRelatedArtists(seed._id.toString(), 10);

    expect(ids(related)).toContain(playable._id.toString());
    expect(ids(related)).not.toContain(emptyButPopular._id.toString());
  });

  /**
   * Vacuity floor. Every assertion above is an absence, so a `getRelatedArtists`
   * that returned nothing at all would satisfy them and prove nothing. This one
   * fails unless real results still come through.
   */
  it('still returns results — the filter narrows, it does not empty', async () => {
    const seed = await makeArtist({ genres: ['jazz'] });
    await makeTrack(seed._id.toString());
    for (let i = 0; i < 3; i += 1) {
      const peer = await makeArtist({ genres: ['jazz'] });
      await makeTrack(peer._id.toString());
    }

    const related = await getRelatedArtists(seed._id.toString(), 10);
    expect(related.length).toBeGreaterThanOrEqual(3);
  });

  it('returns nothing for an id that is not an ObjectId', async () => {
    expect(await getRelatedArtists('not-an-id')).toEqual([]);
  });
});
