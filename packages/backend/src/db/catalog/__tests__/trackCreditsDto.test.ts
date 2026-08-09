import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { catalogEntities, trackCredits, tracks } from '../../schema/catalog';
import { toTrackDtos } from '../hydrate';

/**
 * A track's DTO carries EVERY artist on the record, not just the one that owns
 * it.
 *
 * ## The bug this exists for
 *
 * A recording by two people is stored correctly — the second artist is a
 * `track_credits` row carrying its own `catalog_entity_id` — and every screen in
 * the app showed one name, because nothing loaded the credits. `credits` was
 * declared on the DTO, the serializer knew how to write it, and the only caller
 * of `toTrackDto` never supplied it, so the field was `undefined` on all 25
 * catalog surfaces at once. `tsc` cannot see that: the field is optional.
 *
 * ## Why the assertions look the way they do
 *
 * Each names a VALUE. `toHaveProperty('credits')` and a length check both pass
 * against a `credits: [{}]` that carries none of the fields a screen renders,
 * which is close enough to the defect to be worth excluding.
 *
 * The fixtures are also built so a narrower implementation cannot pass them:
 * two `artist` credits rather than one (a single credit cannot tell "loads the
 * list" from "loads the first"), inserted with `position` DESCENDING relative to
 * intended display order (so a load that returns rows in insertion or physical
 * order fails the ordering assertion instead of accidentally passing it), and a
 * credit with a NULL `catalog_entity_id` beside one that has an id (so
 * "converts NULL to absent" is distinguishable from "returns whatever the column
 * held").
 */

beforeAll(async () => {
  await connectDb();
});
afterEach(async () => {
  await clearDb();
});
afterAll(async () => {
  await disconnectDb();
});

async function makeArtist(name: string): Promise<string> {
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name,
      nameKey: `artist-${uuidv7()}`,
      source: 'upload',
    })
    .returning({ id: catalogEntities.id });

  if (!artist) throw new Error('makeArtist: insert returned no row');
  return artist.id;
}

async function makeTrack(title: string, artistId: string, artistName: string): Promise<string> {
  const [track] = await getDb()
    .insert(tracks)
    .values({
      title,
      artistId,
      artistName,
      duration: 180,
      source: 'upload',
      status: 'ready',
    })
    .returning({ id: tracks.id });

  if (!track) throw new Error('makeTrack: insert returned no row');
  return track.id;
}

async function readTrackRow(id: string) {
  const [row] = await getDb().select().from(tracks).where(eq(tracks.id, id));
  if (!row) throw new Error('readTrackRow: no row');
  return row;
}

describe('toTrackDtos — credits', () => {
  it('carries every performing credit, in stored position order', async () => {
    const principalId = await makeArtist('benny blanco');
    const guestId = await makeArtist('Bb trickz');
    const trackId = await makeTrack('Joven y Salvaje', principalId, 'benny blanco');

    // Inserted in the OPPOSITE order to the positions, so a load that returns
    // rows as they were written disagrees with the assertion below.
    await getDb().insert(trackCredits).values([
      { trackId, position: 1, name: 'Segunda', nameKey: 'segunda', role: 'artist' },
      {
        trackId,
        position: 0,
        name: 'Bb trickz',
        nameKey: 'bb trickz',
        role: 'artist',
        catalogEntityId: guestId,
      },
    ]);

    const [dto] = await toTrackDtos([await readTrackRow(trackId)]);

    expect(dto?.credits?.map((credit) => credit.name)).toEqual(['Bb trickz', 'Segunda']);
    expect(dto?.credits?.[0]?.catalogEntityId).toBe(guestId);
    expect(dto?.credits?.[0]?.role).toBe('artist');
    expect(dto?.credits?.[0]?.nameKey).toBe('bb trickz');
  });

  it('reports an unresolved credit as having NO entity id, not a null one', async () => {
    const principalId = await makeArtist('Solo');
    const trackId = await makeTrack('Un tema', principalId, 'Solo');
    await getDb()
      .insert(trackCredits)
      .values({ trackId, position: 0, name: 'Ana Gil', nameKey: 'ana gil', role: 'producer' });

    const [dto] = await toTrackDtos([await readTrackRow(trackId)]);

    expect(dto?.credits?.[0]?.name).toBe('Ana Gil');
    // `null` would reach a client that only checks presence as a link to
    // nowhere; the DTO's field is optional precisely so it can be absent.
    expect(dto?.credits?.[0]).not.toHaveProperty('catalogEntityId');
  });

  it('keeps each track’s credits on that track when a page holds several', async () => {
    // The failure this excludes is a load that returns one flat list and hands
    // every track the same credits — invisible with a single-track fixture.
    const principalId = await makeArtist('Compartido');
    const first = await makeTrack('Primera', principalId, 'Compartido');
    const second = await makeTrack('Segunda', principalId, 'Compartido');

    await getDb().insert(trackCredits).values([
      { trackId: first, position: 0, name: 'Sólo en primera', nameKey: 'solo-1', role: 'artist' },
      { trackId: second, position: 0, name: 'Sólo en segunda', nameKey: 'solo-2', role: 'artist' },
    ]);

    const rows = await getDb()
      .select()
      .from(tracks)
      .where(inArray(tracks.id, [first, second]))
      .orderBy(tracks.title);
    const dtos = await toTrackDtos(rows);

    expect(dtos.map((dto) => dto.credits?.map((credit) => credit.name))).toEqual([
      ['Sólo en primera'],
      ['Sólo en segunda'],
    ]);
  });

  it('leaves credits absent on a track that has none', async () => {
    const principalId = await makeArtist('Nadie más');
    const trackId = await makeTrack('En solitario', principalId, 'Nadie más');

    const [dto] = await toTrackDtos([await readTrackRow(trackId)]);

    expect(dto?.credits).toBeUndefined();
  });
});
