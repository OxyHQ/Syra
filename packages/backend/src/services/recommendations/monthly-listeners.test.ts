import { beforeAll, afterAll, afterEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { connectDb, clearDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { catalogEntities, tracks, trackCredits } from '../../db/schema/catalog';
import { listeningEvents } from '../../db/schema/user';
import { refreshMonthlyListeners } from './monthly-listeners';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);
const CUTOFF = new Date('2026-09-15T12:00:00Z');
const START = new Date('2026-08-18T12:00:00Z');

async function artist(name: string): Promise<string> {
  const [row] = await getDb().insert(catalogEntities).values({ type: 'artist', name, nameKey: name, source: 'upload' }).returning({ id: catalogEntities.id });
  if (!row) throw new Error('Artist fixture was not inserted');
  return row.id;
}
async function recording(artistId: string): Promise<string> {
  const [row] = await getDb().insert(tracks).values({ artistId, artistName: 'Artist', title: 'Recording', duration: 100, source: 'upload' }).returning({ id: tracks.id });
  if (!row) throw new Error('Track fixture was not inserted');
  return row.id;
}
async function listen(artistId: string, trackId: string, oxyUserId: string, playedAt = START, completion = 1, skipped = false) {
  await getDb().insert(listeningEvents).values({ artistId, trackId, oxyUserId, playedAt, completion, skipped });
}
async function count(artistId: string) {
  const [row] = await getDb().select({ value: catalogEntities.statsMonthlyListeners, computedAt: catalogEntities.statsMonthlyListenersComputedAt }).from(catalogEntities).where(eq(catalogEntities.id, artistId));
  return row;
}
describe('rolling public audience', () => {
  it('counts a listener once across multiple recordings, replays and repeated passes', async () => {
    const principal = await artist('principal');
    const first = await recording(principal);
    const second = await recording(principal);
    await listen(principal, first, 'listener-one');
    await listen(principal, first, 'listener-one');
    await listen(principal, second, 'listener-one');
    await listen(principal, second, 'listener-two');
    expect(await refreshMonthlyListeners(CUTOFF)).toBe(1);
    await refreshMonthlyListeners(CUTOFF);
    expect((await count(principal))?.value).toBe(2);
    expect((await count(principal))?.computedAt?.toISOString()).toBe(CUTOFF.toISOString());
  });
  it('uses [start, cutoff), excludes skips and short listens, and resets expired counts to zero', async () => {
    const principal = await artist('boundaries');
    const track = await recording(principal);
    await listen(principal, track, 'included-at-start', START, 0.3);
    await listen(principal, track, 'too-old', new Date(START.getTime() - 1));
    await listen(principal, track, 'future', CUTOFF);
    await listen(principal, track, 'short', START, 0.299);
    await listen(principal, track, 'skipped', START, 1, true);
    await refreshMonthlyListeners(CUTOFF);
    expect((await count(principal))?.value).toBe(1);
    await refreshMonthlyListeners(new Date('2026-10-15T12:00:00Z'));
    expect((await count(principal))?.value).toBe(0);
  });
  it('credits resolved performers once but does not turn writers or unlinked names into listeners', async () => {
    const principal = await artist('main');
    const guest = await artist('guest');
    const producer = await artist('producer');
    const track = await recording(principal);
    await getDb().insert(trackCredits).values([
      { trackId: track, position: 0, name: 'Guest', nameKey: 'guest', role: 'artist', catalogEntityId: guest },
      { trackId: track, position: 1, name: 'Guest', nameKey: 'guest', role: 'vocalist', catalogEntityId: guest },
      { trackId: track, position: 2, name: 'Producer', nameKey: 'producer', role: 'producer', catalogEntityId: producer },
      { trackId: track, position: 3, name: 'Unknown', nameKey: 'unknown', role: 'artist' },
    ]);
    await listen(principal, track, 'listener');
    await refreshMonthlyListeners(CUTOFF);
    expect((await count(principal))?.value).toBe(1);
    expect((await count(guest))?.value).toBe(1);
    expect((await count(producer))?.value).toBe(0);
  });
  it('leaves an uncomputed artist distinct from a calculated empty audience', async () => {
    const principal = await artist('new');
    expect((await count(principal))?.computedAt).toBeNull();
    await refreshMonthlyListeners(CUTOFF);
    expect((await count(principal))?.value).toBe(0);
    expect((await count(principal))?.computedAt).toEqual(CUTOFF);
  });
});
