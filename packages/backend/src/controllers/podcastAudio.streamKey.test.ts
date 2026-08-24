/**
 * `GET /api/podcasts/episodes/:id/key` — the episode AES-128 key endpoint.
 *
 * WHY THIS FILE EXISTS. Until Task 13a this endpoint had no test at all: the
 * only suite next to the controller was `podcastAudio.parseRange.test.ts`, a
 * pure-function test of the Range header parser. That was survivable while
 * `track_keys` held ONE polymorphic `track_id` serving all three id spaces — the
 * lookup could not name the wrong column because there was only one. The split
 * into `track_id`/`user_upload_id`/`episode_id` makes it a real hazard: reading
 * an episode id out of `track_id` type-checks (same `text` column, same name it
 * always had), returns no row, and answers 404 "Key not found" forever. Nothing
 * in the type system, and nothing that existed in this repo, could tell the two
 * apart.
 *
 * So the assertions below are deliberately about WHICH ARM the key was filed
 * under, not merely that a 200 comes back.
 *
 * ## And about WHO may have it
 *
 * A second hazard, closed later and covered at the end of this file: this
 * handler loaded no episode row at all. It resolved a bitrate cap — which any
 * bearer session satisfies — and read `track_keys` by the id in the URL, so any
 * signed-in user could obtain the AES-128 content key for any episode, including
 * one whose show was private or taken down. The key IS the encryption; with it
 * the segments are plaintext. The full audience matrix lives in
 * `routes/podcastVisibility.matrix.test.ts`; the case kept HERE is the one that
 * belongs beside the key lookup itself.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { uuidv7 } from '@oxyhq/db';
import type { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities, tracks } from '../db/schema/catalog';
import { episodes, podcasts } from '../db/schema/podcasts';
import { trackKeys } from '../db/schema/trackKeys';
import { getEpisodeStreamKey } from './podcastAudio.controller';

process.env.STREAM_TOKEN_SECRET = 'test-secret-podcast-audio-key';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const KEY_HEX = 'deadbeefdeadbeefdeadbeefdeadbeef';

interface CapturedRes {
  _status: number;
  _body: unknown;
  _headers: Record<string, string>;
  status: (code: number) => CapturedRes;
  set: (name: string, value: string) => CapturedRes;
  send: (body: unknown) => CapturedRes;
  json: (body: unknown) => CapturedRes;
}

function makeRes(): CapturedRes {
  const res: CapturedRes = {
    _status: 200,
    _body: undefined,
    _headers: {},
    status(code) { this._status = code; return this; },
    set(name, value) { this._headers[name] = value; return this; },
    send(body) { this._body = body; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

function makeReq(id: string): AuthRequest {
  return { params: { id }, query: {}, user: { id: 'oxy-listener' } } as unknown as AuthRequest;
}

/** A Syra-hosted episode, and the show it belongs to. */
async function seedEpisode(
  visibility: 'private' | 'unlisted' | 'public' = 'public'
): Promise<string> {
  const suffix = uuidv7();
  const [podcast] = await getDb()
    .insert(podcasts)
    .values({
      title: 'Key Endpoint Show',
      feedUrl: `https://example.test/${suffix}.xml`,
      source: 'syra',
      visibility,
      ownerOxyUserId: 'oxy-key-endpoint-owner',
    })
    .returning({ id: podcasts.id });

  const [episode] = await getDb()
    .insert(episodes)
    .values({
      podcastId: podcast.id,
      podcastTitle: 'Key Endpoint Show',
      title: 'Key Endpoint Episode',
      guid: `key-endpoint-${suffix}`,
      pubDate: new Date('2026-01-01T00:00:00.000Z'),
      source: 'syra',
    })
    .returning({ id: episodes.id });

  return episode.id;
}

describe('GET /api/podcasts/episodes/:id/key', () => {
  it('serves the key filed under the EPISODE arm', async () => {
    const episodeId = await seedEpisode();
    await getDb()
      .insert(trackKeys)
      .values({ episodeId, keyHex: KEY_HEX, keyUri: 'key' });
    const res = makeRes();

    await getEpisodeStreamKey(makeReq(episodeId), res as unknown as Response);

    expect(res._status).toBe(200);
    expect(Buffer.isBuffer(res._body)).toBe(true);
    expect((res._body as Buffer).toString('hex')).toBe(KEY_HEX);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('does NOT find a key filed under the catalogue arm for an id of the same shape', async () => {
    /**
     * The mutation this whole file exists to catch, expressed as a test.
     *
     * `episodes.id` and `tracks.id` are both uuid v7, so an episode key
     * mistakenly filed on — or looked up from — `track_id` is invisible to
     * every type check and every constraint. Here a REAL track carries a key
     * and the episode does not; a handler reading `track_id` would have to
     * return that key or 404 by luck, and reading `episode_id` returns 404 by
     * construction.
     */
    const episodeId = await seedEpisode();

    const [artist] = await getDb()
      .insert(catalogEntities)
      .values({ name: 'Key Endpoint Artist', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    const [track] = await getDb()
      .insert(tracks)
      .values({
        title: 'Key Endpoint Track',
        artistId: artist.id,
        artistName: 'Key Endpoint Artist',
        duration: 180,
        source: 'upload',
      })
      .returning({ id: tracks.id });
    await getDb()
      .insert(trackKeys)
      .values({ trackId: track.id, keyHex: KEY_HEX, keyUri: 'key' });

    const res = makeRes();
    await getEpisodeStreamKey(makeReq(episodeId), res as unknown as Response);

    expect(res._status).toBe(404);
    expect(Buffer.isBuffer(res._body)).toBe(false);
  });

  it('404s when the episode has no key at all', async () => {
    const episodeId = await seedEpisode();
    const res = makeRes();

    await getEpisodeStreamKey(makeReq(episodeId), res as unknown as Response);

    expect(res._status).toBe(404);
  });

  it('400s on an id that is not an entity id', async () => {
    const res = makeRes();

    await getEpisodeStreamKey(makeReq('not-an-id'), res as unknown as Response);

    expect(res._status).toBe(400);
  });

  it('refuses a signed-in stranger the key to a PRIVATE show, and 404s rather than 403s', async () => {
    const episodeId = await seedEpisode('private');
    await getDb().insert(trackKeys).values({ episodeId, keyHex: KEY_HEX, keyUri: 'key' });

    const res = makeRes();
    await getEpisodeStreamKey(makeReq(episodeId), res as unknown as Response);

    // 404, not 401 or 403: a private episode has to read exactly like an id that
    // names nothing, or the status code sorts real ids from made-up ones.
    expect(res._status).toBe(404);
    expect(Buffer.isBuffer(res._body)).toBe(false);
  });

  it('serves the same key to the OWNER — so the refusal above is the gate, not a missing key', async () => {
    // The positive control for the case above, on the SAME fixture shape. The
    // key really is stored and really is servable; the only difference is who
    // asked. Without this, "404 for a private show" would also be satisfied by a
    // handler that had simply stopped finding keys.
    const episodeId = await seedEpisode('private');
    await getDb().insert(trackKeys).values({ episodeId, keyHex: KEY_HEX, keyUri: 'key' });

    const res = makeRes();
    const asOwner = {
      params: { id: episodeId },
      query: {},
      user: { id: 'oxy-key-endpoint-owner' },
    } as unknown as AuthRequest;
    await getEpisodeStreamKey(asOwner, res as unknown as Response);

    expect(res._status).toBe(200);
    expect((res._body as Buffer).toString('hex')).toBe(KEY_HEX);
  });
});
