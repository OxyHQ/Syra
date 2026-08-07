import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { and, count, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { catalogEntities } from '../../db/schema/catalog';
import {
  resolvePersons,
  buildCreatorPersons,
  enrichPersons,
  type GetOxyUsers,
} from './resolvePersons';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const noOxy: GetOxyUsers = async () => [];
const echoOxy: GetOxyUsers = async (ids) =>
  ids.map((id) => ({ id, avatar: `avatar-${id}`, displayName: `User ${id}`, username: `user_${id}` }));

/**
 * How many `type = 'person'` rows exist.
 *
 * `type` is STATED, and that is why this helper exists rather than a bare
 * `count()` over the table: artists and persons share `catalog_entities`, so an
 * unscoped count would include every artist a fixture creates and silently
 * absorb a resolver that started writing the wrong type.
 */
async function personCount(): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(catalogEntities)
    .where(eq(catalogEntities.type, 'person'));
  return row?.total ?? 0;
}

async function findPersonByOxyId(linkedOxyUserId: string) {
  const [row] = await getDb()
    .select({ id: catalogEntities.id })
    .from(catalogEntities)
    .where(
      and(eq(catalogEntities.type, 'person'), eq(catalogEntities.linkedOxyUserId, linkedOxyUserId))
    )
    .limit(1);
  return row;
}

/** An artist row — `source` is required for artists by a CHECK constraint. */
async function makeArtist(name: string, extra: { claimedByOxyUserId?: string } = {}) {
  await getDb()
    .insert(catalogEntities)
    .values({ type: 'artist', name, source: 'upload', ...extra });
}

describe('resolvePersons — strong-key dedup', () => {
  it('dedupes by linkedOxyUserId and enriches with the live Oxy identity', async () => {
    const r1 = await resolvePersons([{ name: 'A', role: 'host', linkedOxyUserId: 'oxy1' }], echoOxy);
    const r2 = await resolvePersons([{ name: 'totally different', role: 'guest', linkedOxyUserId: 'oxy1' }], echoOxy);

    expect(r1[0].personId).toBe(r2[0].personId); // one global person
    expect(await personCount()).toBe(1);
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
    expect(await personCount()).toBe(1);
  });

  it('NEVER merges a name-only credit into a strong-key person of the same name', async () => {
    const strongOxy: GetOxyUsers = async (ids) => ids.map((id) => ({ id, displayName: 'Joe Rogan' }));
    await resolvePersons([{ name: 'Joe Rogan', linkedOxyUserId: 'oxyJoe' }], strongOxy);

    const r = await resolvePersons([{ name: 'Joe Rogan' }], noOxy); // name-only RSS credit
    const strong = await findPersonByOxyId('oxyJoe');

    expect(strong).toBeDefined();
    expect(r[0].personId).not.toBe(strong?.id);
    expect(r[0].linkedOxyUserId).toBeUndefined();
    expect(await personCount()).toBe(2); // separate low-confidence person
  });

  it('dedupes two name-only credits with the same (case-insensitive) name', async () => {
    const r1 = await resolvePersons([{ name: 'Solo Host', img: 'https://x/a.jpg' }], noOxy);
    const r2 = await resolvePersons([{ name: 'solo host' }], noOxy);
    expect(r1[0].personId).toBe(r2[0].personId);
    expect(await personCount()).toBe(1);
  });

  it('links to a CLAIMED artist by exact name (owner-verified)', async () => {
    await makeArtist('Verified Host', { claimedByOxyUserId: 'oxyV' });
    const r = await resolvePersons([{ name: 'verified host', href: 'https://x/vh' }], noOxy); // case-insensitive
    expect(r[0].linkedArtistId).toBeDefined();
  });

  it('does NOT link to an UNCLAIMED artist (name match alone is insufficient)', async () => {
    await makeArtist('Unclaimed Name'); // no owner/claim
    const r = await resolvePersons([{ name: 'Unclaimed Name', href: 'https://x/un' }], noOxy);
    expect(r[0].linkedArtistId).toBeUndefined();
  });

  it('does NOT link to a PERSON of the same name, however owned', async () => {
    /**
     * The fixture that separates the scoped artist lookup from an unscoped one.
     *
     * Every other case in this block seeds an ARTIST, so a query that dropped
     * `type = 'artist'` would pass all of them. A person row carrying an owner is
     * representable, and linking one into `linked_artist_id` would violate what
     * that column means while satisfying `catalog_entities`' own discriminator
     * CHECK, which only forbids the column on non-persons.
     */
    await getDb()
      .insert(catalogEntities)
      .values({ type: 'person', name: 'Ambiguous Name', ownerOxyUserId: 'oxyP' });

    const r = await resolvePersons([{ name: 'Ambiguous Name', href: 'https://x/amb' }], noOxy);
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
    // Plain string ids: `PersonLike._id` is `id` since the port, and there is no
    // `ObjectId` arm left for a drizzle row to have to satisfy.
    const oxyId = uuidv7();
    const rssId = uuidv7();

    const result = await enrichPersons(
      [
        { id: oxyId, name: 'stored name', linkedOxyUserId: 'oxy1' },
        { id: rssId, name: 'RSS Host', img: 'https://x/a.jpg' },
      ],
      echoOxy,
    );

    const oxy = result.find((p) => p.linkedOxyUserId === 'oxy1');
    expect(oxy?.name).toBe('User oxy1');
    expect(oxy?.displayName).toBe('User oxy1');
    expect(oxy?.username).toBe('user_oxy1');
    expect(oxy?.oxyAvatar).toBe('avatar-oxy1');
    expect(oxy?.img).toBeUndefined();

    const rss = result.find((p) => p.personId === rssId);
    expect(rss?.name).toBe('RSS Host');
    expect(rss?.img).toBe('https://x/a.jpg');
    expect(rss?.oxyAvatar).toBeUndefined();
  });
});
