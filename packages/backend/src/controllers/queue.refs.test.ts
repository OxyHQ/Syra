/**
 * The queue resolves `PlayableRef`s, and a locker ref resolves for its owner only.
 *
 * This is the reason the queue stopped taking bare track ids. An id alone is
 * ambiguous across two collections, and the tempting resolution — try the
 * catalog, fall back to the locker — puts the ownership check on the second
 * attempt only, which is a check that exists but does not always run.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll, mock } from 'bun:test';
import type { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities, tracks } from '../db/schema/catalog';
import { userUploadHlsRenditions, userUploads } from '../db/schema/creators';
import { replaceQueue, getQueueHandler } from './queue.controller';

// The queue lives in Redis. A fake keyed by user id keeps this about REF
// RESOLUTION — which is in the controller — rather than about Redis being up.
const queues = new Map<string, string>();
const fakeRedis = {
  isReady: true,
  get: async (key: string) => queues.get(key) ?? null,
  setEx: async (key: string, _ttl: number, value: string) => { queues.set(key, value); },
  del: async (key: string) => { queues.delete(key); },
};
mock.module('../utils/redis', () => ({ getRedisClient: () => fakeRedis }));


/**
 * BOTH databases, which is exactly the split this suite is about: the catalogue
 * is Postgres and the locker (`UserUpload`) is still Mongo until Task 13. The
 * two-collection ambiguity the queue's `(kind, id)` addressing exists to remove
 * is now a two-DATABASE ambiguity, and resolving a ref by trying one and
 * falling back to the other would be even worse than before.
 */
beforeAll(connectDb);
afterEach(async () => {
  await clearDb();
  queues.clear();
});
afterAll(disconnectDb);

const OWNER = 'oxy-owner';
const STRANGER = 'oxy-stranger';

interface CapturedRes {
  _status: number;
  _body: unknown;
  status: (code: number) => CapturedRes;
  json: (body: unknown) => CapturedRes;
  send: (body: unknown) => CapturedRes;
  set: () => CapturedRes;
}

function makeRes(): CapturedRes {
  const res: CapturedRes = {
    _status: 200,
    _body: undefined,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
    set() { return this; },
  };
  return res;
}

function makeReq(userId: string, body: unknown): AuthRequest {
  return { params: {}, query: {}, body, user: { id: userId } } as unknown as AuthRequest;
}

const rethrow = (error: unknown): void => { if (error) throw error; };

let shaCounter = 0;

async function seedUpload(ownerOxyUserId = OWNER): Promise<{ id: string }> {
  shaCounter += 1;
  const [upload] = await getDb()
    .insert(userUploads)
    .values({
      ownerOxyUserId,
      title: 'Midnight Ferry',
      artistName: 'Nadia Ortiz',
      duration: 210,
      sizeBytes: 1024,
      sha256: shaCounter.toString(16).padStart(64, '0'),
      status: 'ready',
      playCount: 0,
      audioSourceKey: `locker/${ownerOxyUserId}/x/source.mp3`,
      audioSourceFormat: 'mp3',
      hlsMasterKey: `hls/${ownerOxyUserId}/x/master.m3u8`,
    })
    .returning({ id: userUploads.id });
  // The ladder is a child table now.
  await getDb().insert(userUploadHlsRenditions).values({
    userUploadId: upload.id,
    position: 0,
    manifestKey: `hls/${ownerOxyUserId}/x/160/index.m3u8`,
    bitrateKbps: 160,
    encrypted: true,
  });
  return upload;
}

/** Seeds the artist and the catalogue track; returns the track id. */
async function seedTrack(): Promise<string> {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: `Someone ${suffix}`,
      nameKey: `someone-${suffix}`,
      source: 'upload',
    })
    .returning({ id: catalogEntities.id });
  if (!artist) throw new Error('seedTrack: artist insert returned no row');

  const [track] = await getDb()
    .insert(tracks)
    .values({
      title: 'A Catalogue Track',
      artistId: artist.id,
      artistName: 'Someone',
      duration: 180,
      source: 'upload',
      status: 'ready',
      isAvailable: true,
      isExplicit: false,
    })
    .returning({ id: tracks.id });
  if (!track) throw new Error('seedTrack: track insert returned no row');

  return track.id;
}

describe('PUT /api/queue — resolving refs', () => {
  it('queues a catalogue track and a locker file side by side, tagged', async () => {
    const trackId = await seedTrack();
    const upload = await seedUpload();
    const res = makeRes();

    await replaceQueue(
      makeReq(OWNER, {
        refs: [
          { kind: 'track', id: trackId },
          { kind: 'upload', id: upload.id },
        ],
        current: 0,
      }),
      res as unknown as Response,
      rethrow,
    );

    expect(res._status).toBe(200);
    const queue = (res._body as { queue: { tracks: Array<{ id: string; kind: string }> } }).queue;
    expect(queue.tracks.map((item) => item.kind)).toEqual(['track', 'upload']);
    expect(queue.tracks.map((item) => item.id)).toEqual([
      trackId,
      upload.id,
    ]);
  });

  it('refuses somebody ELSE’s locker file', async () => {
    const upload = await seedUpload(STRANGER);
    const res = makeRes();

    await replaceQueue(
      makeReq(OWNER, { refs: [{ kind: 'upload', id: upload.id }], current: 0 }),
      res as unknown as Response,
      rethrow,
    );

    // Indistinguishable from an id that does not exist — which is the point.
    expect(res._status).toBe(404);
    expect((res._body as { unavailableRefs: unknown[] }).unavailableRefs).toHaveLength(1);
  });

  it('will not reach a locker file through a `track` ref', async () => {
    // The id is real and the caller owns the file; only the KIND is wrong. If
    // resolution ever fell back across collections, this would succeed.
    const upload = await seedUpload();
    const res = makeRes();

    await replaceQueue(
      makeReq(OWNER, { refs: [{ kind: 'track', id: upload.id }], current: 0 }),
      res as unknown as Response,
      rethrow,
    );

    expect(res._status).toBe(404);
  });

  it('refuses a locker file that is still transcoding', async () => {
    const upload = await seedUpload();
    await getDb()
      .update(userUploads)
      .set({ status: 'processing' })
      .where(eq(userUploads.id, upload.id));
    const res = makeRes();

    await replaceQueue(
      makeReq(OWNER, { refs: [{ kind: 'upload', id: upload.id }], current: 0 }),
      res as unknown as Response,
      rethrow,
    );

    // The locker's equivalent of `playableTrackFilter`: a file with no HLS ladder
    // yet would queue silence.
    expect(res._status).toBe(404);
  });

  it('refuses a soft-deleted locker file', async () => {
    const upload = await seedUpload();
    await getDb()
      .update(userUploads)
      .set({ deletedAt: new Date() })
      .where(eq(userUploads.id, upload.id));
    const res = makeRes();

    await replaceQueue(
      makeReq(OWNER, { refs: [{ kind: 'upload', id: upload.id }], current: 0 }),
      res as unknown as Response,
      rethrow,
    );

    expect(res._status).toBe(404);
  });

  it('replaces all or nothing', async () => {
    const trackId = await seedTrack();
    const foreign = await seedUpload(STRANGER);
    const res = makeRes();

    await replaceQueue(
      makeReq(OWNER, {
        refs: [
          { kind: 'track', id: trackId },
          { kind: 'upload', id: foreign.id },
        ],
        current: 0,
      }),
      res as unknown as Response,
      rethrow,
    );

    // A partial queue would silently drop whatever the caller meant to play.
    expect(res._status).toBe(404);
    expect(queues.size).toBe(0);
  });

  it('rejects a payload still using the old `trackIds` shape', async () => {
    // Clean cut, no dual-read: the old field is not accepted anywhere.
    const trackId = await seedTrack();
    const res = makeRes();

    await replaceQueue(
      makeReq(OWNER, { trackIds: [trackId], current: 0 }),
      res as unknown as Response,
      rethrow,
    );

    expect(res._status).toBe(400);
  });

  it('keeps the kind tag through a round trip', async () => {
    const upload = await seedUpload();
    await replaceQueue(
      makeReq(OWNER, { refs: [{ kind: 'upload', id: upload.id }], current: 0 }),
      makeRes() as unknown as Response,
      rethrow,
    );

    const res = makeRes();
    await getQueueHandler(makeReq(OWNER, {}), res as unknown as Response, rethrow);

    // The tag is the only thing telling the player to resolve this through
    // `/api/uploads/:id/stream`; losing it on the way back out would strand it.
    const body = res._body as { tracks: Array<{ kind: string }> };
    expect(body.tracks.map((item) => item.kind)).toEqual(['upload']);
  });

  it('never puts a storage key in the queue', async () => {
    const upload = await seedUpload();
    const res = makeRes();

    await replaceQueue(
      makeReq(OWNER, { refs: [{ kind: 'upload', id: upload.id }], current: 0 }),
      res as unknown as Response,
      rethrow,
    );

    const serialised = JSON.stringify(res._body);
    expect(serialised).not.toContain('locker/oxy-owner/x/source.mp3');
    expect(serialised).not.toContain('hls/oxy-owner/x/master.m3u8');
  });
});
