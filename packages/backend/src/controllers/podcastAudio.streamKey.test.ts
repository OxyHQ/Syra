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
async function seedEpisode(): Promise<string> {
  const suffix = uuidv7();
  const [podcast] = await getDb()
    .insert(podcasts)
    .values({
      title: 'Key Endpoint Show',
      feedUrl: `https://example.test/${suffix}.xml`,
      source: 'syra',
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
});
