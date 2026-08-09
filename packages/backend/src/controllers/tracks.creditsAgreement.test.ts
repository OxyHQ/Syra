/**
 * The listing and the detail view must describe the same credit.
 *
 * ## The bug this exists for
 *
 * `track_credits` had two readers. The listing path loaded every column the DTO
 * declares; the track DETAIL endpoint named its own three — `name`, `role`,
 * `nameKey` — and omitted `catalogEntityId`. So the identical credit came back
 * LINKED from search and UNLINKED from `GET /api/tracks/:id`.
 *
 * The consequence is worse than a missing link on one screen: an unlinked
 * credit is exactly what a credit that was never resolved to an artist looks
 * like, and the two are indistinguishable from outside. This was read as the
 * data being wrong, and a repair was written for a database that was already
 * correct. A projection that silently drops a column produces evidence, not
 * just a missing feature.
 *
 * Both readers now go through `loadTrackCredits`. This test is what keeps them
 * from diverging again: it asserts the two surfaces agree about a credit that
 * HAS a link, which is the only shape that can tell them apart — a credit with
 * no `catalogEntityId` comes back identical from a correct reader and from one
 * that drops the column.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities, trackCredits, tracks } from '../db/schema/catalog';
import { toTrackDtos } from '../db/catalog/hydrate';
import { getTrackById } from './tracks.controller';

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
  set(name: string, value: string): CapturedRes;
  json(body: unknown): CapturedRes;
}

function makeRes(): CapturedRes {
  return {
    _status: 200,
    _body: undefined,
    status(code) { this._status = code; return this; },
    set() { return this; },
    json(body) { this._body = body; return this; },
  };
}

const next: NextFunction = (err?: unknown) => {
  if (err) throw err;
};

describe('track credits — listing and detail agree', () => {
  it('returns the SAME linked credit from both readers', async () => {
    const [principal] = await getDb()
      .insert(catalogEntities)
      .values({ type: 'artist', name: 'benny blanco', nameKey: 'benny-blanco-x', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const [guest] = await getDb()
      .insert(catalogEntities)
      .values({ type: 'artist', name: 'Bb trickz', nameKey: 'bb-trickz-x', source: 'upload' })
      .returning({ id: catalogEntities.id });
    if (!principal || !guest) throw new Error('fixture: artist insert returned no row');

    const [track] = await getDb()
      .insert(tracks)
      .values({
        title: 'Joven y Salvaje',
        artistId: principal.id,
        artistName: 'benny blanco',
        duration: 122,
        source: 'upload',
        status: 'ready',
      })
      .returning({ id: tracks.id });
    if (!track) throw new Error('fixture: track insert returned no row');

    // The credit CARRIES a link. A credit without one cannot distinguish a
    // reader that keeps the column from one that drops it.
    await getDb().insert(trackCredits).values({
      trackId: track.id,
      position: 0,
      name: 'Bb trickz',
      nameKey: 'bb trickz',
      role: 'artist',
      catalogEntityId: guest.id,
    });

    const [row] = await getDb().select().from(tracks).where(eq(tracks.id, track.id));
    if (!row) throw new Error('fixture: track row disappeared');
    const [listed] = await toTrackDtos([row]);

    const res = makeRes();
    await getTrackById(
      { params: { id: track.id }, query: {} } as unknown as Request,
      res as unknown as Response,
      next
    );
    // `getTrackById` responds with the track object itself, not a `{ data }`
    // envelope — asserted here so a reshaped response cannot make this test
    // read `undefined` from both sides and pass.
    expect(res._status).toBe(200);
    const body = res._body as { id?: string; credits?: Array<{ catalogEntityId?: string }> };
    expect(body.id).toBe(track.id);
    const detailCredits = body.credits;

    expect(listed?.credits?.[0]?.catalogEntityId).toBe(guest.id);
    expect(detailCredits?.[0]?.catalogEntityId).toBe(guest.id);
    expect(detailCredits).toEqual(listed?.credits ?? []);
  });
});
