/**
 * `PATCH /api/podcasts/:id` — changing the cover art REPLACES the palette.
 *
 * The sibling of `uploads.controller.test.ts`'s "clears the stored palette when
 * the new cover art has none". Both controllers had the same defect for the
 * same reason, and it is a difference between the two ORMs rather than anything
 * about podcasts or uploads:
 *
 * > **In drizzle, `undefined` in a `.set()` means "leave this column alone";
 * > `null` means "clear it". In Mongoose they were the same thing** — assigning
 * > `undefined` to a path made `save()` issue `$unset`.
 *
 * Here the stripping is explicit as well as implicit: `db/podcasts/podcasts.ts`'s
 * `definedOnly` drops undefined keys BEFORE drizzle would. That helper is right
 * for what it was written for — a feed refresh carrying no `<podcast:funding>`
 * must not erase creator-added links — so the fix is at the call site, where a
 * creator is explicitly changing the cover and the new cover decides both
 * accents INCLUDING deciding they are absent.
 *
 * This file is Task 12's vertical. Task 13 crossed into it because Task 12 is
 * closed, the bug is unowned and live, and the fix pattern was already in hand
 * from the identical defect in the locker.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { Response } from 'express';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { imageAssets } from '../db/schema/catalog';
import { podcasts } from '../db/schema/podcasts';
import { findPodcastById } from '../db/podcasts/podcasts';
import { updatePodcast } from './podcasts.controller';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const OWNER = 'oxy-podcast-owner';

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

function makeReq(podcastId: string, body: Record<string, unknown>): AuthRequest {
  return { params: { id: podcastId }, body, user: { id: OWNER } } as unknown as AuthRequest;
}

/** A show this owner may edit: `source: 'syra'` and owned, which the guard requires. */
async function makeOwnedShow(colors: { primaryColor: string; secondaryColor: string }): Promise<string> {
  const [row] = await getDb()
    .insert(podcasts)
    .values({
      title: 'A Show',
      source: 'syra',
      ownerOxyUserId: OWNER,
      feedUrl: `https://feed.example/${Math.random().toString(36).slice(2)}.xml`,
      primaryColor: colors.primaryColor,
      secondaryColor: colors.secondaryColor,
    })
    .returning({ id: podcasts.id });
  if (!row) throw new Error('makeOwnedShow: insert returned no row');
  return row.id;
}

/** `image_assets.primary_color` is nullable and `storeImageAsset` takes the palette as OPTIONAL input. */
async function makeImage(colors?: { primaryColor: string; secondaryColor?: string }): Promise<string> {
  const [row] = await getDb()
    .insert(imageAssets)
    .values({
      s3Key: `images/cover/${Math.random().toString(36).slice(2)}.jpg`,
      filename: 'cover.jpg',
      contentType: 'image/jpeg',
      byteSize: 2048,
      width: 1400,
      height: 1400,
      ownerType: 'podcast',
      primaryColor: colors?.primaryColor,
      secondaryColor: colors?.secondaryColor,
    })
    .returning({ id: imageAssets.id });
  if (!row) throw new Error('makeImage: insert returned no row');
  return row.id;
}

describe('PATCH /api/podcasts/:id — cover art replaces the palette', () => {
  it('clears both accents when the new cover has none', async () => {
    const id = await makeOwnedShow({ primaryColor: '#ff0000', secondaryColor: '#00ff00' });
    const colourless = await makeImage();
    const res = makeRes();

    await updatePodcast(makeReq(id, { image: colourless }), res as unknown as Response);

    expect(res._status).toBe(200);
    const after = await findPodcastById(id);
    expect(after?.imageId).toBe(colourless);
    expect(after?.primaryColor).toBeNull();
    expect(after?.secondaryColor).toBeNull();
  });

  /**
   * The half-palette case, which the primary-only coalesce would still miss.
   *
   * `resolveCover` answers `secondaryColor: undefined` for an asset that has a
   * primary and no secondary, so a fix that coalesced only `primaryColor` would
   * leave the OLD secondary beside the NEW primary — two accents from two
   * different images.
   */
  it('clears the secondary when the new cover has only a primary', async () => {
    const id = await makeOwnedShow({ primaryColor: '#ff0000', secondaryColor: '#00ff00' });
    const primaryOnly = await makeImage({ primaryColor: '#0000ff' });
    const res = makeRes();

    await updatePodcast(makeReq(id, { image: primaryOnly }), res as unknown as Response);

    expect(res._status).toBe(200);
    const after = await findPodcastById(id);
    expect(after?.primaryColor).toBe('#0000ff');
    expect(after?.secondaryColor).toBeNull();
  });

  it('carries both accents across when the new cover has both', async () => {
    // The positive case, so the two above cannot pass by clearing unconditionally.
    const id = await makeOwnedShow({ primaryColor: '#ff0000', secondaryColor: '#00ff00' });
    const full = await makeImage({ primaryColor: '#0000ff', secondaryColor: '#ffff00' });
    const res = makeRes();

    await updatePodcast(makeReq(id, { image: full }), res as unknown as Response);

    expect(res._status).toBe(200);
    const after = await findPodcastById(id);
    expect(after?.primaryColor).toBe('#0000ff');
    expect(after?.secondaryColor).toBe('#ffff00');
  });

  it('leaves the palette alone when the PATCH does not touch the image', async () => {
    // The other half of the ORM distinction: a field the caller did not send
    // must still mean "leave alone", which is what `definedOnly` is for.
    const id = await makeOwnedShow({ primaryColor: '#ff0000', secondaryColor: '#00ff00' });
    const res = makeRes();

    await updatePodcast(makeReq(id, { title: 'Renamed' }), res as unknown as Response);

    expect(res._status).toBe(200);
    const after = await findPodcastById(id);
    expect(after?.title).toBe('Renamed');
    expect(after?.primaryColor).toBe('#ff0000');
    expect(after?.secondaryColor).toBe('#00ff00');
  });
});
