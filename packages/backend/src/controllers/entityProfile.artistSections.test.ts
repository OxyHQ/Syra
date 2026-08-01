import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import type { Request, Response, NextFunction } from 'express';
import type { EntityProfile } from '@syra/shared-types';
import { PlaylistVisibility } from '@syra/shared-types';
import { connect, clear, disconnect } from '../test/mongo';
import { ArtistModel, PersonModel } from '../models/CatalogEntity';
import { TrackModel } from '../models/Track';
import { AlbumModel } from '../models/Album';
import { PlaylistModel } from '../models/Playlist';
import { PlaylistTrackModel } from '../models/PlaylistTrack';
import { ContributionAttestationModel } from '../models/ContributionAttestation';
import { getEntityProfile } from './entityProfile.controller';

/**
 * The sections exist in the service and are unit-tested there. These assert the
 * only thing those tests cannot: that `GET /api/p/:id` actually PUTS them on the
 * response, for BOTH ways a profile can be addressed — by artist id, and by the
 * id of a person linked to that artist. A section wired into one branch and
 * forgotten in the other typechecks perfectly and is invisible until somebody
 * opens the wrong URL.
 */

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

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

/** An artist with one EP, one taken-down single, a guest credit and a playlist. */
async function seedRichArtist() {
  const artist = await ArtistModel.create({
    name: 'Rich Artist',
    source: 'upload',
    origin: 'contributed',
    claimable: true,
    country: 'ES',
    sources: [{ provider: 'cc', externalId: 'mb-1', importedAt: '2026-01-01', fields: ['bio', 'country'] }],
  });
  const artistId = artist._id.toString();

  const ep = await AlbumModel.create({
    title: 'The EP', artistId, artistName: 'Rich Artist',
    releaseDate: '2025-06-01', coverArt: new mongoose.Types.ObjectId().toString(), type: 'ep',
  });
  const ownTrack = await TrackModel.create({
    title: 'Own Song', artistId, artistName: 'Rich Artist', duration: 200,
    source: 'upload', status: 'ready', albumId: ep._id.toString(),
  });

  // A recording somebody else published onto this profile.
  const contributed = await TrackModel.create({
    title: 'Contributed Song', artistId, artistName: 'Rich Artist', duration: 190,
    source: 'upload', status: 'ready',
  });
  await ContributionAttestationModel.create({
    trackId: contributed._id.toString(),
    uploaderOxyUserId: 'a-stranger',
    statement: 'I may distribute this recording',
    acceptedAt: new Date(),
  });

  // A track by somebody ELSE that credits this artist as a producer.
  const host = await ArtistModel.create({ name: 'Another Band', source: 'upload' });
  const creditedTrack = await TrackModel.create({
    title: 'Produced By Them', artistId: host._id.toString(), artistName: 'Another Band',
    duration: 210, source: 'upload', status: 'ready',
    credits: [{ name: 'Rich Artist', role: 'producer', nameKey: 'rich artist' }],
  });

  const playlist = await PlaylistModel.create({
    name: 'A Public Mix', ownerOxyUserId: 'curator-1', ownerUsername: 'curator',
    visibility: PlaylistVisibility.PUBLIC,
  });
  await PlaylistTrackModel.create({
    playlistId: playlist._id, trackId: ownTrack._id.toString(),
    addedAt: new Date().toISOString(), order: 0,
  });

  return {
    artistId,
    epId: ep._id.toString(),
    ownTrackId: ownTrack._id.toString(),
    contributedTrackId: contributed._id.toString(),
    creditedTrackId: creditedTrack._id.toString(),
    playlistId: playlist._id.toString(),
  };
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
    await PlaylistModel.updateOne(
      { _id: seed.playlistId },
      { visibility: PlaylistVisibility.PRIVATE },
    );

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
    await ArtistModel.updateOne({ _id: seed.artistId }, {
      $set: {
        imageLicence: LICENCE,
        sortName: 'Artist, Rich',
        disambiguation: 'Spanish producer',
        artistType: 'person',
        activeFrom: '2011',
        activeUntil: '2024',
        aliases: ['R. Artist', 'Rico'],
        labels: ['Harbour Records'],
        members: [{ name: 'Rich Artist', role: 'vocals' }],
      },
    });

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
    await ArtistModel.updateOne({ _id: seed.artistId }, {
      $set: { imageLicence: LICENCE, aliases: ['R. Artist'], activeFrom: '2011' },
    });
    const person = await PersonModel.create({
      name: 'Rich Artist',
      linkedArtistId: new mongoose.Types.ObjectId(seed.artistId),
    });

    const res = makeRes();
    await getEntityProfile(makeReq(person._id.toString()), res as unknown as Response, failNext);
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
    const person = await PersonModel.create({
      name: 'Rich Artist',
      linkedArtistId: new mongoose.Types.ObjectId(seed.artistId),
    });

    const res = makeRes();
    await getEntityProfile(makeReq(person._id.toString()), res as unknown as Response, failNext);
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
    const person = await PersonModel.create({ name: 'Just A Host' });

    const res = makeRes();
    await getEntityProfile(makeReq(person._id.toString()), res as unknown as Response, failNext);
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
    const artist = await ArtistModel.create({ name: 'Silent', source: 'upload' });

    const res = makeRes();
    await getEntityProfile(makeReq(artist._id.toString()), res as unknown as Response, failNext);
    const profile = profileOf(res);

    expect(profile.discography).toEqual({ albums: [], singlesAndEps: [], compilations: [] });
    expect(profile.creditedOn).toEqual([]);
    expect(profile.playlists).toEqual([]);
    expect(profile.profileState?.claimable).toBe(false);
  });
});
