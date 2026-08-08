import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getImage } from './images.controller';
import type { NextFunction, Request, Response } from 'express';

/**
 * `GET /api/images/:id` — the id-shape guard, and nothing else.
 *
 * The live defect this file pins: the guard was
 * `mongoose.Types.ObjectId.isValid`, while `services/imageAssetService.ts`
 * mints a uuid v7 for every image uploaded since the cutover. So the endpoint
 * that SERVES an image 400'd every image the endpoint beside it had just
 * minted, and every `/api/images/<id>` URL `db/catalog/serialize.ts` writes
 * into a cover art field.
 *
 * `playlists.controller.test.ts` covers the same guard on the WRITE side (a
 * client-supplied `coverArt`). That fix landed; this one — the read side of the
 * same id space — outlived it, which is why the coverage is per-endpoint rather
 * than per-id-space.
 *
 * ## Why a 404 is the assertion for a well-formed id
 *
 * `getImageAssetStream` returns `null` for an id matching no row WITHOUT
 * reaching S3, so a well-formed id that names nothing is a 404 that proves the
 * request got PAST the guard. That is the discriminator: under the old guard a
 * uuid v7 never reached the query at all and came back 400.
 *
 * The malformed cases are not decoration — they are what stops a blanket
 * removal of the guard from passing this file. Deleting the guard outright
 * turns those 400s into 404s.
 */

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

interface CapturedRes {
  _status: number;
  _body: unknown;
  status(code: number): CapturedRes;
  json(body: unknown): CapturedRes;
  setHeader(): CapturedRes;
}

function makeRes(): CapturedRes {
  return {
    _status: 200,
    _body: undefined,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    setHeader() { return this; },
  };
}

const next: NextFunction = (err?: unknown) => {
  if (err) throw err;
};

async function getThrough(id: string): Promise<CapturedRes> {
  const res = makeRes();
  const req = { params: { id }, query: {} } as unknown as Request;
  await getImage(req, res as unknown as Response, next);
  return res;
}

describe('GET /api/images/:id', () => {
  /**
   * The uuid v7 is the fixture that makes the strict and loose guards disagree.
   * A 24-hex ObjectId passes both, so a suite carrying only that shape would
   * have reported the broken guard as correct.
   */
  it('lets a uuid v7 reach the lookup, which the ObjectId guard rejected', async () => {
    const res = await getThrough(uuidv7());

    expect(res._status).toBe(404);
    expect(res._body).toMatchObject({ error: 'Image not found' });
  });

  /**
   * The Mongo-era shape stays live permanently: a backfill copies the original
   * id verbatim, so a row migrated from Mongo keeps its ObjectId forever. This
   * is the assertion that stops the fix from becoming "accept uuids instead of
   * ObjectIds" rather than "accept both".
   */
  it('still lets a 24-hex ObjectId reach the lookup', async () => {
    const res = await getThrough('6a7682e9da69b80bbfbf97bd');

    expect(res._status).toBe(404);
    expect(res._body).toMatchObject({ error: 'Image not found' });
  });

  it('rejects an id of neither live shape', async () => {
    for (const id of ['', 'not-an-id', '/api/images/x', 'https://x/y.jpg', 'zzzzzzzzzzzzzzzzzzzzzzzz']) {
      const res = await getThrough(id);
      expect(`${id || '<empty>'} -> ${res._status}`).toBe(`${id || '<empty>'} -> 400`);
    }
  });
});
