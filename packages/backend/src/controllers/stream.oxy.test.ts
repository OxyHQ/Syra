import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { uuidv7 } from '@oxy.so/db';
import type { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { installFakeOxyFiles, resetOxyFiles, type FakeOxyFiles } from '../test/fakeOxyFiles';
import { getDb } from '../db/postgres';
import { catalogEntities, trackHlsRenditions, tracks } from '../db/schema/catalog';
import { oxyAudioFiles } from '../db/schema/oxyFiles';
import { getOxyMasterPlaylist, getStream } from './stream.controller';
import { permittedRenditions } from '../services/stream/oxyPlayback';

/**
 * `GET /api/stream/:trackId` plays a track from its Oxy audio file (ADR 0043
 * stage 4c) when `OXY_AUDIO` allows it and Oxy's ladder is ready — under the
 * listener's bitrate cap — and from the legacy ladder in every other case.
 */

process.env.STREAM_TOKEN_SECRET = 'test-secret-stream-oxy';

let fake: FakeOxyFiles;

beforeAll(connectDb);
beforeEach(() => {
  fake = installFakeOxyFiles();
  process.env.OXY_AUDIO = 'dual';
});
afterEach(async () => {
  delete process.env.OXY_AUDIO;
  resetOxyFiles();
  await clearDb();
});
afterAll(disconnectDb);

interface CapturedRes {
  _status: number;
  _body: unknown;
  status: (code: number) => CapturedRes;
  set: () => CapturedRes;
  send: (body: unknown) => CapturedRes;
  json: (body: unknown) => CapturedRes;
}

function makeRes(): CapturedRes {
  return {
    _status: 200,
    _body: undefined,
    status(code) {
      this._status = code;
      return this;
    },
    set() {
      return this;
    },
    send(body) {
      this._body = body;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    },
  };
}

function req(params: Record<string, string>, query: Record<string, string> = {}): AuthRequest {
  return { params, query, user: { id: 'listener' } } as unknown as AuthRequest;
}

async function seedTrack(withLegacyLadder: boolean): Promise<{ trackId: string; fileId: string }> {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({ type: 'artist', name: `A ${suffix}`, nameKey: `a-${suffix}`, source: 'upload' })
    .returning({ id: catalogEntities.id });
  const file = fake.seedFile({
    bytes: Buffer.from(`audio-${suffix}`),
    mime: 'audio/mpeg',
    ownerApplicationId: fake.applicationId,
    visibility: 'private',
  });
  const [track] = await getDb()
    .insert(tracks)
    .values({
      title: 'T',
      artistId: artist!.id,
      artistName: 'A',
      duration: 180,
      source: 'upload',
      status: 'ready',
      audioFileId: file.id,
      hlsMasterKey: withLegacyLadder ? 'hls/a/t/master.m3u8' : null,
    })
    .returning({ id: tracks.id });
  await getDb()
    .insert(oxyAudioFiles)
    .values({ fileId: file.id, ownerKind: 'application', mime: 'audio/mpeg' });
  if (withLegacyLadder) {
    await getDb().insert(trackHlsRenditions).values({
      trackId: track!.id,
      position: 0,
      manifestKey: 'hls/a/t/96/index.m3u8',
      bitrateKbps: 96,
      encrypted: true,
    });
  }
  return { trackId: track!.id, fileId: file.id };
}

describe('permittedRenditions', () => {
  const ladder = [64, 128, 256].map((kbps) => ({
    type: `hls_a${kbps}`,
    url: `https://o/${kbps}`,
    bandwidth: kbps * 1000,
  }));

  it('keeps the rungs at or under the cap, and the lowest one under any cap', () => {
    expect(permittedRenditions(ladder, 320).map((r) => r.type)).toEqual([
      'hls_a64',
      'hls_a128',
      'hls_a256',
    ]);
    expect(permittedRenditions(ladder, 160).map((r) => r.type)).toEqual(['hls_a64', 'hls_a128']);
    expect(permittedRenditions(ladder, 32).map((r) => r.type)).toEqual(['hls_a64']);
  });
});

describe('GET /api/stream/:trackId with the audio in Oxy Files', () => {
  it("plays from an Oxy session under a free listener's cap, with Oxy's preview and waveform", async () => {
    const { trackId, fileId } = await seedTrack(false);
    fake.renderLadder(fileId);

    const res = makeRes();
    await getStream(req({ trackId }), res as unknown as Response);
    expect(res._status).toBe(200);
    const body = res._body as {
      url: string;
      type: string;
      previewUrl: string;
      waveformUrl: string;
    };
    expect(body.type).toBe('hls');
    expect(body.previewUrl).toMatch(/preview\.m4a$/);
    expect(body.waveformUrl).toMatch(/waveform\.json$/);

    // Free (160 kbps): Syra's capped master, listing the 64k and 128k rungs only.
    const capped = new URL(body.url, 'http://syra.test');
    const m = capped.searchParams.get('m');
    expect(capped.pathname).toBe('/api/stream/oxy/master.m3u8');
    const master = makeRes();
    await getOxyMasterPlaylist(req({}, { m: m! }), master as unknown as Response);
    expect(master._status).toBe(200);
    const playlist = master._body as string;
    expect(playlist).toContain('/hls_a64/index.m3u8');
    expect(playlist).toContain('/hls_a128/index.m3u8');
    expect(playlist).not.toContain('hls_a256');
  });

  it('refuses a forged capped master', async () => {
    const res = makeRes();
    await getOxyMasterPlaylist(req({}, { m: 'not-a-token' }), res as unknown as Response);
    expect(res._status).toBe(401);
  });

  it('plays the legacy ladder while Oxy has not rendered its own', async () => {
    const { trackId } = await seedTrack(true);
    const res = makeRes();
    await getStream(req({ trackId }), res as unknown as Response);
    expect(res._status).toBe(200);
    expect((res._body as { url: string }).url).toContain(`/api/stream/${trackId}/master.m3u8?t=`);
  });

  it('answers 409 processing when the only ladder is the one Oxy is still rendering', async () => {
    const { trackId } = await seedTrack(false);
    const res = makeRes();
    await getStream(req({ trackId }), res as unknown as Response);
    expect(res._status).toBe(409);
  });

  it('plays the legacy ladder and never calls Oxy in legacy mode', async () => {
    delete process.env.OXY_AUDIO;
    const { trackId, fileId } = await seedTrack(true);
    fake.renderLadder(fileId);
    const res = makeRes();
    await getStream(req({ trackId }), res as unknown as Response);
    expect((res._body as { url: string }).url).toContain(`/api/stream/${trackId}/master.m3u8?t=`);
    expect(fake.calls.filter((call) => call.method === 'streams.create')).toEqual([]);
  });

  it('refuses a file Oxy reported withdrawn — legacy ladder included', async () => {
    const { trackId, fileId } = await seedTrack(true);
    await getDb().update(oxyAudioFiles).set({ status: 'blocked' });
    fake.renderLadder(fileId);
    const res = makeRes();
    await getStream(req({ trackId }), res as unknown as Response);
    expect(res._status).toBe(403);
  });
});
