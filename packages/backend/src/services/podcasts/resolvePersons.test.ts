import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../../test/mongo';
import { PersonModel, ArtistModel } from '../../models/CatalogEntity';
import {
  resolvePersons,
  buildCreatorPersons,
  enrichPersons,
  strongKeyCreditMatch,
  type GetOxyUsers,
} from './resolvePersons';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

const noOxy: GetOxyUsers = async () => [];
const echoOxy: GetOxyUsers = async (ids) =>
  ids.map((id) => ({ id, avatar: `avatar-${id}`, displayName: `User ${id}`, username: `user_${id}` }));

describe('resolvePersons — strong-key dedup', () => {
  it('dedupes by linkedOxyUserId and enriches with the live Oxy identity', async () => {
    const r1 = await resolvePersons([{ name: 'A', role: 'host', linkedOxyUserId: 'oxy1' }], echoOxy);
    const r2 = await resolvePersons([{ name: 'totally different', role: 'guest', linkedOxyUserId: 'oxy1' }], echoOxy);

    expect(r1[0].personId).toBe(r2[0].personId); // one global Person
    expect(await PersonModel.countDocuments({})).toBe(1);
    // Oxy enrichment: live displayName + avatar id, no external img.
    expect(r1[0].name).toBe('User oxy1');
    expect(r1[0].displayName).toBe('User oxy1');
    expect(r1[0].oxyAvatar).toBe('avatar-oxy1');
    expect(r1[0].username).toBe('user_oxy1'); // handle for /u/[username] nav
    expect(r1[0].img).toBeUndefined();
    expect(r1[0].linkedOxyUserId).toBe('oxy1');
  });

  it('dedupes by href (stable RSS identity)', async () => {
    const r1 = await resolvePersons([{ name: 'Jane', href: 'https://x/jane' }], noOxy);
    const r2 = await resolvePersons([{ name: 'Jane Doe', href: 'https://x/jane' }], noOxy);
    expect(r1[0].personId).toBe(r2[0].personId);
    expect(await PersonModel.countDocuments({})).toBe(1);
  });

  it('NEVER merges a name-only credit into a strong-key person of the same name', async () => {
    const strongOxy: GetOxyUsers = async (ids) => ids.map((id) => ({ id, displayName: 'Joe Rogan' }));
    await resolvePersons([{ name: 'Joe Rogan', linkedOxyUserId: 'oxyJoe' }], strongOxy);

    const r = await resolvePersons([{ name: 'Joe Rogan' }], noOxy); // name-only RSS credit
    const strong = await PersonModel.findOne({ linkedOxyUserId: 'oxyJoe' }).lean();

    expect(strong).not.toBeNull();
    expect(r[0].personId).not.toBe(strong?._id.toString());
    expect(r[0].linkedOxyUserId).toBeUndefined();
    expect(await PersonModel.countDocuments({})).toBe(2); // separate low-confidence person
  });

  it('dedupes two name-only credits with the same (case-insensitive) name', async () => {
    const r1 = await resolvePersons([{ name: 'Solo Host', img: 'https://x/a.jpg' }], noOxy);
    const r2 = await resolvePersons([{ name: 'solo host' }], noOxy);
    expect(r1[0].personId).toBe(r2[0].personId);
    expect(await PersonModel.countDocuments({})).toBe(1);
  });

  it('links to a CLAIMED Artist by exact name (owner-verified)', async () => {
    await ArtistModel.create({ name: 'Verified Host', source: 'upload', claimedByOxyUserId: 'oxyV' });
    const r = await resolvePersons([{ name: 'verified host', href: 'https://x/vh' }], noOxy); // case-insensitive
    expect(r[0].linkedArtistId).toBeDefined();
  });

  it('does NOT link to an UNCLAIMED Artist (name match alone is insufficient)', async () => {
    await ArtistModel.create({ name: 'Unclaimed Name', source: 'audius' }); // no owner/claim
    const r = await resolvePersons([{ name: 'Unclaimed Name', href: 'https://x/un' }], noOxy);
    expect(r[0].linkedArtistId).toBeUndefined();
  });
});

describe('buildCreatorPersons — Oxy-only validation', () => {
  it('builds host/guest credits for valid Oxy ids', async () => {
    const { persons, invalidIds } = await buildCreatorPersons({ hosts: ['h1'], guests: ['g1'] }, echoOxy);

    expect(invalidIds).toHaveLength(0);
    expect(persons).toHaveLength(2);
    const host = persons.find((p) => p.linkedOxyUserId === 'h1');
    expect(host?.role).toBe('host');
    expect(host?.name).toBe('User h1');
    expect(persons.find((p) => p.linkedOxyUserId === 'g1')?.role).toBe('guest');
  });

  it('rejects ids that are not real Oxy users (no free text)', async () => {
    const onlyReal: GetOxyUsers = async (ids) =>
      ids.filter((id) => id === 'real').map((id) => ({ id, displayName: 'Real' }));
    const { persons, invalidIds } = await buildCreatorPersons({ hosts: ['real', 'fake'] }, onlyReal);

    expect(invalidIds).toEqual(['fake']);
    expect(persons).toHaveLength(0);
  });

  it('credits a user listed as both host and guest as host', async () => {
    const { persons } = await buildCreatorPersons({ hosts: ['u1'], guests: ['u1'] }, echoOxy);
    expect(persons).toHaveLength(1);
    expect(persons[0].role).toBe('host');
  });
});

describe('enrichPersons', () => {
  it('enriches Oxy-linked persons (avatar/displayName/username); keeps img for RSS', async () => {
    const oxyId = new mongoose.Types.ObjectId();
    const rssId = new mongoose.Types.ObjectId();

    const result = await enrichPersons(
      [
        { _id: oxyId, name: 'stored name', linkedOxyUserId: 'oxy1' },
        { _id: rssId, name: 'RSS Host', img: 'https://x/a.jpg' },
      ],
      echoOxy,
    );

    const oxy = result.find((p) => p.linkedOxyUserId === 'oxy1');
    expect(oxy?.name).toBe('User oxy1');
    expect(oxy?.displayName).toBe('User oxy1');
    expect(oxy?.username).toBe('user_oxy1');
    expect(oxy?.oxyAvatar).toBe('avatar-oxy1');
    expect(oxy?.img).toBeUndefined();

    const rss = result.find((p) => p.personId === rssId.toString());
    expect(rss?.name).toBe('RSS Host');
    expect(rss?.img).toBe('https://x/a.jpg');
    expect(rss?.oxyAvatar).toBeUndefined();
  });
});

describe('strongKeyCreditMatch', () => {
  it('keys on linkedOxyUserId, then href, then exact name', () => {
    const base = { _id: new mongoose.Types.ObjectId(), name: 'Jane Host' };
    expect(strongKeyCreditMatch({ ...base, linkedOxyUserId: 'oxy1' })).toEqual({
      persons: { $elemMatch: { linkedOxyUserId: 'oxy1' } },
    });
    expect(strongKeyCreditMatch({ ...base, href: 'https://x/jane' })).toEqual({
      persons: { $elemMatch: { href: 'https://x/jane' } },
    });
    const nameMatch = strongKeyCreditMatch(base);
    const elem = (nameMatch.persons as { $elemMatch: { name: RegExp } }).$elemMatch;
    expect(elem.name).toBeInstanceOf(RegExp);
    expect('jane host').toMatch(elem.name); // exact, case-insensitive
    expect('jane host extra').not.toMatch(elem.name);
  });
});
