import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { Request, Response, NextFunction } from 'express';
import type { EntityProfile } from '@syra/shared-types';
import { normalizeNameKey, PlaylistVisibility } from '@syra/shared-types';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import {
  albums,
  catalogEntities,
  catalogEntitySources,
  imageAssets,
  trackCredits,
  tracks,
} from '../db/schema/catalog';
import { playlistTracks, playlists } from '../db/schema/library';
import { contributionAttestations } from '../db/schema/creators';
import { getEntityProfile } from './entityProfile.controller';

/**
 * The sections exist in the service and are unit-tested there. These assert the
 * only thing those tests cannot: that `GET /api/p/:id` actually PUTS them on the
 * response, for BOTH ways a profile can be addressed — by artist id, and by the
 * id of a person linked to that artist. A section wired into one branch and
 * forgotten in the other typechecks perfectly and is invisible until somebody
 * opens the wrong URL.
 */

/**
 * POSTGRES ONLY.
 *
 * This block used to say the opposite, and the reason it was wrong is worth
 * keeping: nothing here reads a Mongoose model, but `entityProfile.controller`
 * still GATED every handler on `isDatabaseConnected()` — Mongoose readiness —
 * so without a Mongo connection every request answered 503 and these suites had
 * to open one. The guard was the whole dependency.
 *
 * Task 15 switched that gate to `isPostgresConnected()`, and the Mongo hooks
 * went with it. `db/__tests__/connectivityGates.test.ts` is what keeps this
 * true: it walks this controller's whole import graph and fails if anything it
 * reaches opens a model again.
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

interface CapturedRes {
  _status: number;
  _body: unknown;
  status(code: number): CapturedRes;
  json(body: unknown): CapturedRes;
}

function makeRes(): CapturedRes {
  return {
    _status: 200,
    _body: undefined,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
}

const failNext: NextFunction = (err) => { throw err; };

function makeReq(id: string, userId?: string): Request {
  return {
    params: { id },
    query: {},
    user: userId ? { id: userId } : undefined,
  } as unknown as Request;
}

function profileOf(res: CapturedRes): EntityProfile {
  return (res._body as { data: EntityProfile }).data;
}

/** An `image_assets` row, so a cover art / photo reference resolves. */
async function makeImageAsset(ownerType: 'album' | 'artist'): Promise<string> {
  const [asset] = await getDb()
    .insert(imageAssets)
    .values({
      s3Key: `fixtures/${uuidv7()}.jpg`,
      filename: 'c.jpg',
      contentType: 'image/jpeg',
      byteSize: 1,
      width: 640,
      height: 640,
      ownerType,
    })
    .returning({ id: imageAssets.id });

  if (!asset) throw new Error('makeImageAsset: insert returned no row');
  return asset.id;
}

/** An artist with one EP, one taken-down single, a guest credit and a playlist. */
async function seedRichArtist() {
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: 'Rich Artist',
      /**
       * `normalizeNameKey('Rich Artist')`, written explicitly.
       *
       * Mongoose DERIVED this from `name` in a pre-save hook, so the old fixture
       * never mentioned it — and `loadCreditedOn` matches
       * `track_credits.name_key` against exactly this value, which is why a
       * fixture that invented a unique key here returns an EMPTY credited-on
       * shelf and still looks like a seeded artist. Stable rather than
       * suffixed: `catalog_entities_artist_name_key_key` is unique over artists,
       * and `clearDb` truncates between tests, so the only collision risk is
       * within one fixture — where the two artists differ.
       */
      nameKey: normalizeNameKey('Rich Artist'),
      source: 'upload',
      origin: 'contributed',
      claimable: true,
      country: 'ES',
    })
    .returning({ id: catalogEntities.id });
  if (!artist) throw new Error('seedRichArtist: artist insert returned no row');
  const artistId = artist.id;

  // `sources[]` is a child table now, not an embedded array.
  await getDb().insert(catalogEntitySources).values({
    catalogEntityId: artistId,
    position: 0,
    provider: 'cc',
    externalId: 'mb-1',
    importedAt: new Date('2026-01-01T00:00:00Z'),
    fields: ['bio', 'country'],
  });

  const [ep] = await getDb()
    .insert(albums)
    .values({
      title: 'The EP',
      artistId,
      artistName: 'Rich Artist',
      releaseDate: '2025-06-01',
      coverArtId: await makeImageAsset('album'),
      type: 'ep',
    })
    .returning({ id: albums.id });
  if (!ep) throw new Error('seedRichArtist: album insert returned no row');

  const [ownTrack] = await getDb()
    .insert(tracks)
    .values({
      title: 'Own Song', artistId, artistName: 'Rich Artist', duration: 200,
      source: 'upload', status: 'ready', albumId: ep.id,
    })
    .returning({ id: tracks.id });
  if (!ownTrack) throw new Error('seedRichArtist: own track insert returned no row');

  // A recording somebody else published onto this profile.
  const [contributed] = await getDb()
    .insert(tracks)
    .values({
      title: 'Contributed Song', artistId, artistName: 'Rich Artist', duration: 190,
      source: 'upload', status: 'ready',
    })
    .returning({ id: tracks.id });
  if (!contributed) throw new Error('seedRichArtist: contributed track insert returned no row');

  await getDb().insert(contributionAttestations).values({
    trackId: contributed.id,
    uploaderOxyUserId: 'a-stranger',
    statement: 'I may distribute this recording',
    acceptedAt: new Date(),
  });

  // A track by somebody ELSE that credits this artist as a producer.
  const [host] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist', name: 'Another Band', nameKey: normalizeNameKey('Another Band'),
      source: 'upload',
    })
    .returning({ id: catalogEntities.id });
  if (!host) throw new Error('seedRichArtist: host insert returned no row');

  const [creditedTrack] = await getDb()
    .insert(tracks)
    .values({
      title: 'Produced By Them', artistId: host.id, artistName: 'Another Band',
      duration: 210, source: 'upload', status: 'ready',
    })
    .returning({ id: tracks.id });
  if (!creditedTrack) throw new Error('seedRichArtist: credited track insert returned no row');

  // `credits[]` is `track_credits` now — the one subdocument array that DID
  // become a child table, because `loadCreditedOn` queries it by element.
  await getDb().insert(trackCredits).values({
    trackId: creditedTrack.id, position: 0, name: 'Rich Artist', role: 'producer',
    nameKey: normalizeNameKey('Rich Artist'),
  });

  const [playlist] = await getDb()
    .insert(playlists)
    .values({
      name: 'A Public Mix', ownerOxyUserId: 'curator-1', ownerUsername: 'curator',
      visibility: PlaylistVisibility.PUBLIC,
    })
    .returning({ id: playlists.id });
  if (!playlist) throw new Error('seedRichArtist: playlist insert returned no row');

  await getDb().insert(playlistTracks).values({
    playlistId: playlist.id, trackId: ownTrack.id, addedAt: new Date(), position: 0,
  });

  return {
    artistId,
    epId: ep.id,
    ownTrackId: ownTrack.id,
    contributedTrackId: contributed.id,
    creditedTrackId: creditedTrack.id,
    playlistId: playlist.id,
  };
}

/** A `type:'person'` row, optionally linked to an artist. */
async function makePerson(name: string, linkedArtistId?: string): Promise<string> {
  const [person] = await getDb()
    .insert(catalogEntities)
    .values({ type: 'person', name, ...(linkedArtistId ? { linkedArtistId } : {}) })
    .returning({ id: catalogEntities.id });

  if (!person) throw new Error('makePerson: insert returned no row');
  return person.id;
}

function ids(list: unknown[] | undefined): string[] {
  return (list ?? []).map((item) => (item as { id: string }).id);
}

describe('GET /api/p/:id — artist sections on the artist branch', () => {
  it('serves discography, credited-on, playlists and profile state', async () => {
    const seed = await seedRichArtist();

    const res = makeRes();
    await getEntityProfile(makeReq(seed.artistId), res as unknown as Response, failNext);
    const profile = profileOf(res);

    expect(profile.kind).toBe('artist');
    expect(profile.country).toBe('ES');

    expect(ids(profile.discography?.singlesAndEps)).toEqual([seed.epId]);
    expect(profile.discography?.albums).toEqual([]);
    expect(profile.discography?.compilations).toEqual([]);

    expect(profile.creditedOn).toHaveLength(1);
    expect(profile.creditedOn?.[0]?.track.id).toBe(seed.creditedTrackId);
    expect(profile.creditedOn?.[0]?.roles).toEqual(['producer']);

    expect(ids(profile.playlists)).toEqual([seed.playlistId]);

    expect(profile.profileState?.origin).toBe('contributed');
    expect(profile.profileState?.claimable).toBe(true);
    expect(profile.profileState?.claimed).toBe(false);
    expect(profile.profileState?.externallySourcedFields.sort()).toEqual(['bio', 'country']);
    expect(profile.profileState?.contributedTrackIds).toEqual([seed.contributedTrackId]);
  });

  /**
   * `contributedTrackIds` is only meaningful against the tracks the page shows,
   * so it is computed from `music.tracks` — this asserts the two agree rather
   * than the ids referring to something the client never received.
   */
  it('reports contributed ids that are present in music.tracks', async () => {
    const seed = await seedRichArtist();

    const res = makeRes();
    await getEntityProfile(makeReq(seed.artistId), res as unknown as Response, failNext);
    const profile = profileOf(res);

    const shown = ids(profile.music?.tracks);
    expect(shown).toContain(seed.contributedTrackId);
    for (const id of profile.profileState?.contributedTrackIds ?? []) {
      expect(shown).toContain(id);
    }
  });

  it('hides a private playlist from a guest and shows it to its owner', async () => {
    const seed = await seedRichArtist();
    await getDb()
      .update(playlists)
      .set({ visibility: PlaylistVisibility.PRIVATE })
      .where(eq(playlists.id, seed.playlistId));

    const guest = makeRes();
    await getEntityProfile(makeReq(seed.artistId), guest as unknown as Response, failNext);
    expect(profileOf(guest).playlists).toEqual([]);

    const owner = makeRes();
    await getEntityProfile(makeReq(seed.artistId, 'curator-1'), owner as unknown as Response, failNext);
    expect(ids(profileOf(owner).playlists)).toEqual([seed.playlistId]);
  });
});

/**
 * The licence has to be ON THE WIRE, not merely in the database.
 *
 * CC BY-SA is discharged by naming the author and linking the licence WHERE the
 * image is displayed. `artistSchema` carried `imageLicence` and
 * `entityProfileSchema` did not, so the storing half existed and the rendering
 * half could not — the frontend had no data to render an attribution line from,
 * and no frontend change could have fixed it. A Commons photo served that way is
 * a licence breach, which is why this is asserted rather than assumed.
 */
describe('GET /api/p/:id — attribution reaches the client', () => {
  const LICENCE = {
    licence: 'CC-BY-SA-4.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    attribution: 'Jane Photographer',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Artist.jpg',
  };

  it('serves imageLicence and the identity fields on the ARTIST branch', async () => {
    const seed = await seedRichArtist();
    await getDb()
      .update(catalogEntities)
      .set({
        // The embedded `imageLicence` object is four flat columns now.
        imageLicenceLicence: LICENCE.licence,
        imageLicenceLicenceUrl: LICENCE.licenceUrl,
        imageLicenceAttribution: LICENCE.attribution,
        imageLicenceSourceUrl: LICENCE.sourceUrl,
        sortName: 'Artist, Rich',
        disambiguation: 'Spanish producer',
        artistType: 'person',
        activeFrom: '2011',
        activeUntil: '2024',
        aliases: ['R. Artist', 'Rico'],
        labels: ['Harbour Records'],
        // Still `jsonb`, and it reaches the wire only because `toArtistDto`
        // names it — an allowlist drops silently, and this assertion is the one
        // thing that would have caught the port removing it.
        members: [{ name: 'Rich Artist', nameKey: normalizeNameKey('Rich Artist') }],
      })
      .where(eq(catalogEntities.id, seed.artistId));

    const res = makeRes();
    await getEntityProfile(makeReq(seed.artistId), res as unknown as Response, failNext);
    const profile = profileOf(res);

    // Every field the licence needs, or the attribution line cannot be rendered.
    expect(profile.imageLicence?.attribution).toBe('Jane Photographer');
    expect(profile.imageLicence?.licence).toBe('CC-BY-SA-4.0');
    expect(profile.imageLicence?.sourceUrl).toContain('commons.wikimedia.org/wiki/File:');
    expect(profile.imageLicence?.licenceUrl).toContain('creativecommons.org');

    expect(profile.sortName).toBe('Artist, Rich');
    expect(profile.disambiguation).toBe('Spanish producer');
    expect(profile.artistType).toBe('person');
    expect(profile.activeFrom).toBe('2011');
    expect(profile.activeUntil).toBe('2024');
    expect(profile.aliases).toEqual(['R. Artist', 'Rico']);
    expect(profile.labels).toEqual(['Harbour Records']);
    expect(profile.members?.[0]?.name).toBe('Rich Artist');
    expect(profile.country).toBe('ES');
  });

  /**
   * The person branch renders the linked artist's photo, so it owes the same
   * attribution. A guard that held on one branch and not the other would breach
   * the licence on exactly the page addressed by a person id.
   */
  it('serves them on the PERSON branch too, from the linked artist', async () => {
    const seed = await seedRichArtist();
    await getDb()
      .update(catalogEntities)
      .set({
        imageLicenceLicence: LICENCE.licence,
        imageLicenceLicenceUrl: LICENCE.licenceUrl,
        imageLicenceAttribution: LICENCE.attribution,
        imageLicenceSourceUrl: LICENCE.sourceUrl,
        aliases: ['R. Artist'],
        activeFrom: '2011',
      })
      .where(eq(catalogEntities.id, seed.artistId));
    const personId = await makePerson('Rich Artist', seed.artistId);

    const res = makeRes();
    await getEntityProfile(makeReq(personId), res as unknown as Response, failNext);
    const profile = profileOf(res);

    expect(profile.kind).toBe('person');
    expect(profile.imageLicence?.attribution).toBe('Jane Photographer');
    expect(profile.aliases).toEqual(['R. Artist']);
    expect(profile.activeFrom).toBe('2011');
    expect(profile.country).toBe('ES');
  });

  it('omits the licence entirely for an artist with no external photo', async () => {
    const seed = await seedRichArtist();

    const res = makeRes();
    await getEntityProfile(makeReq(seed.artistId), res as unknown as Response, failNext);

    expect(profileOf(res).imageLicence).toBeUndefined();
  });
});

describe('GET /api/p/:id — the same sections on the PERSON branch', () => {
  it('serves the linked artist\'s sections when addressed by person id', async () => {
    const seed = await seedRichArtist();
    const personId = await makePerson('Rich Artist', seed.artistId);

    const res = makeRes();
    await getEntityProfile(makeReq(personId), res as unknown as Response, failNext);
    const profile = profileOf(res);

    expect(profile.kind).toBe('person');
    expect(profile.linkedArtistId).toBe(seed.artistId);
    expect(ids(profile.discography?.singlesAndEps)).toEqual([seed.epId]);
    expect(profile.creditedOn?.[0]?.roles).toEqual(['producer']);
    expect(ids(profile.playlists)).toEqual([seed.playlistId]);
    expect(profile.profileState?.claimable).toBe(true);
    expect(profile.country).toBe('ES');
  });

  it('omits the artist sections entirely for a person with no linked artist', async () => {
    const personId = await makePerson('Just A Host');

    const res = makeRes();
    await getEntityProfile(makeReq(personId), res as unknown as Response, failNext);
    const profile = profileOf(res);

    expect(profile.kind).toBe('person');
    expect(profile.discography).toBeUndefined();
    expect(profile.creditedOn).toBeUndefined();
    expect(profile.playlists).toBeUndefined();
    expect(profile.profileState).toBeUndefined();
  });
});

describe('GET /api/p/:id — empty sections stay empty', () => {
  it('returns empty shelves for an artist with nothing playable', async () => {
    const [artist] = await getDb()
      .insert(catalogEntities)
      .values({
        type: 'artist', name: 'Silent', nameKey: normalizeNameKey('Silent'), source: 'upload',
      })
      .returning({ id: catalogEntities.id });
    if (!artist) throw new Error('insert returned no row');

    const res = makeRes();
    await getEntityProfile(makeReq(artist.id), res as unknown as Response, failNext);
    const profile = profileOf(res);

    expect(profile.discography).toEqual({ albums: [], singlesAndEps: [], compilations: [] });
    expect(profile.creditedOn).toEqual([]);
    expect(profile.playlists).toEqual([]);
    expect(profile.profileState?.claimable).toBe(false);
  });
});
