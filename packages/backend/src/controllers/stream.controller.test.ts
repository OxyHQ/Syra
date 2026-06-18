import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../test/mongo';
import { TrackModel } from '../models/Track';
import { TrackKeyModel } from '../models/TrackKey';
import { UserMusicPreferencesModel } from '../models/UserMusicPreferences';
import { getStream, getStreamKey, getVariantPlaylist } from './stream.controller';
import { verifyStreamToken, mintStreamToken } from '../services/stream/streamToken';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { Response } from 'express';

// Ensure STREAM_TOKEN_SECRET is set before module load
process.env.STREAM_TOKEN_SECRET = 'test-secret-stream-controller';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

// ── Fake req/res helpers ──────────────────────────────────────────────────────

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

function makeReq(
  trackId: string,
  opts: {
    authed?: boolean;
    userId?: string;
    query?: Record<string, string>;
    variant?: string;
  } = {},
): AuthRequest {
  const { authed = true, userId = 'oxy-user-abc', query = {}, variant } = opts;
  return {
    params: { trackId, ...(variant !== undefined ? { variant } : {}) },
    query,
    user: authed ? { id: userId } : undefined,
  } as unknown as AuthRequest;
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

const KEY_HEX = 'deadbeefdeadbeefdeadbeefdeadbeef';

async function seedTrack(overrides: Record<string, unknown> = {}) {
  return TrackModel.create({
    title: 'Test',
    artistId: new mongoose.Types.ObjectId().toString(),
    artistName: 'Artist',
    duration: 180,
    source: 'audius',
    status: 'ready',
    isExplicit: false,
    isAvailable: true,
    ...overrides,
  });
}

async function seedKey(trackId: string) {
  return TrackKeyModel.create({ trackId, keyHex: KEY_HEX, keyUri: 'key' });
}

function hlsTrackFields() {
  return {
    source: 'upload',
    status: 'ready',
    hlsMasterKey: 'hls/artist/track/master.m3u8',
    hls: [
      { manifestKey: 'hls/artist/track/96/index.m3u8', bitrateKbps: 96, encrypted: true },
      { manifestKey: 'hls/artist/track/160/index.m3u8', bitrateKbps: 160, encrypted: true },
      { manifestKey: 'hls/artist/track/320/index.m3u8', bitrateKbps: 320, encrypted: true },
    ],
  };
}

// ── getStream — existing tests ────────────────────────────────────────────────

describe('getStream', () => {
  it('200 audius: returns direct provider stream only when the user enabled it', async () => {
    const track = await seedTrack({
      source: 'audius',
      status: 'ready',
      streamUrl: 'https://audius.co/stream/abc123',
    });
    await UserMusicPreferencesModel.create({
      oxyUserId: 'oxy-user-abc',
      directAudiusStreaming: true,
    });

    const req = makeReq(track._id.toString());
    const res = makeRes();
    await getStream(req, res as unknown as Response);

    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(body.type).toBe('audius');
    expect(body.url).toBe('https://audius.co/stream/abc123');
    expect(res._headers['Cache-Control']).toBe('private, max-age=300');
    expect(res._headers.Vary).toBe('Authorization');
  });

  it('422 audius: direct provider streaming is disabled by default', async () => {
    const track = await seedTrack({
      source: 'audius',
      status: 'ready',
      streamUrl: 'https://audius.co/stream/abc123',
    });

    const req = makeReq(track._id.toString());
    const res = makeRes();
    await getStream(req, res as unknown as Response);

    expect(res._status).toBe(422);
  });

  it('200 hls: mints stream token and returns master.m3u8 url', async () => {
    const track = await seedTrack({
      source: 'upload',
      status: 'ready',
      hlsMasterKey: 'hls/artist/track/master.m3u8',
      hls: [{ manifestKey: 'hls/artist/track/128k/index.m3u8', bitrateKbps: 128, encrypted: true }],
    });

    const req = makeReq(track._id.toString());
    const res = makeRes();
    await getStream(req, res as unknown as Response);

    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(body.type).toBe('hls');
    expect(typeof body.url).toBe('string');

    const url = body.url as string;
    expect(url).toContain(`/api/stream/${track._id.toString()}/master.m3u8?t=`);

    const tParam = new URL(url, 'http://localhost').searchParams.get('t');
    expect(tParam).not.toBeNull();
    const claims = verifyStreamToken(tParam as string);
    expect(claims).not.toBeNull();
    expect(claims?.trackId).toBe(track._id.toString());
    expect(claims?.userId).toBe('oxy-user-abc');
    expect(body.expiresAt).toBeDefined();
    expect(res._headers['Cache-Control']).toBe('private, max-age=300');
    expect(res._headers.Vary).toBe('Authorization');
  });

  it('401 audius: no auth cannot use direct provider streaming', async () => {
    const track = await seedTrack({
      source: 'audius',
      status: 'ready',
      streamUrl: 'https://audius.co/stream/anon123',
    });

    const req = makeReq(track._id.toString(), { authed: false });
    const res = makeRes();
    await getStream(req, res as unknown as Response);

    expect(res._status).toBe(401);
  });

  it('401 audius: no auth + missing streamUrl returns 401', async () => {
    const track = await seedTrack({ source: 'audius', status: 'ready', streamUrl: undefined });
    const req = makeReq(track._id.toString(), { authed: false });
    const res = makeRes();
    await getStream(req, res as unknown as Response);
    expect(res._status).toBe(401);
  });

  it('401: HLS track with no auth returns 401', async () => {
    const track = await seedTrack({
      source: 'upload',
      status: 'ready',
      hlsMasterKey: 'hls/artist/track/master.m3u8',
      hls: [{ manifestKey: 'hls/artist/track/128k/index.m3u8', bitrateKbps: 128, encrypted: true }],
    });
    const req = makeReq(track._id.toString(), { authed: false });
    const res = makeRes();
    await getStream(req, res as unknown as Response);
    expect(res._status).toBe(401);
  });

  it('400: invalid ObjectId', async () => {
    const req = makeReq('not-an-id');
    const res = makeRes();
    await getStream(req, res as unknown as Response);
    expect(res._status).toBe(400);
  });

  it('404: track not found', async () => {
    const req = makeReq(new mongoose.Types.ObjectId().toString());
    const res = makeRes();
    await getStream(req, res as unknown as Response);
    expect(res._status).toBe(404);
  });

  it('403: track is unavailable', async () => {
    const track = await seedTrack({ isAvailable: false });
    const req = makeReq(track._id.toString());
    const res = makeRes();
    await getStream(req, res as unknown as Response);
    expect(res._status).toBe(403);
  });

  it('403: track is copyright-removed', async () => {
    const track = await seedTrack({ copyrightRemoved: true });
    const req = makeReq(track._id.toString());
    const res = makeRes();
    await getStream(req, res as unknown as Response);
    expect(res._status).toBe(403);
  });

  it('409: track is still processing', async () => {
    const track = await seedTrack({ status: 'processing', source: 'upload' });
    const req = makeReq(track._id.toString());
    const res = makeRes();
    await getStream(req, res as unknown as Response);
    expect(res._status).toBe(409);
  });

  it('422: track is failed / not playable', async () => {
    const track = await seedTrack({ status: 'failed', source: 'upload' });
    const req = makeReq(track._id.toString());
    const res = makeRes();
    await getStream(req, res as unknown as Response);
    expect(res._status).toBe(422);
  });

  // ── Entitlement cap baked into minted token ──────────────────────────────────

  it('free user (no PREMIUM_USER_IDS): token has maxBitrateKbps=160', async () => {
    const saved = process.env.PREMIUM_USER_IDS;
    delete process.env.PREMIUM_USER_IDS;
    try {
      const track = await seedTrack(hlsTrackFields());
      const req = makeReq(track._id.toString(), { userId: 'free-user' });
      const res = makeRes();
      await getStream(req, res as unknown as Response);

      expect(res._status).toBe(200);
      const url = (res._body as Record<string, unknown>).url as string;
      const t = new URL(url, 'http://localhost').searchParams.get('t');
      const claims = verifyStreamToken(t as string);
      expect(claims?.maxBitrateKbps).toBe(160);
    } finally {
      if (saved !== undefined) process.env.PREMIUM_USER_IDS = saved;
      else delete process.env.PREMIUM_USER_IDS;
    }
  });

  it('premium user with high audioQuality pref: token has maxBitrateKbps=320', async () => {
    const saved = process.env.PREMIUM_USER_IDS;
    process.env.PREMIUM_USER_IDS = 'premium-user';
    try {
      const userId = 'premium-user';
      // Premium user with high quality preference — should reach 320
      await UserMusicPreferencesModel.create({
        oxyUserId: userId,
        audioQuality: 'high',
      });

      const track = await seedTrack(hlsTrackFields());
      const req = makeReq(track._id.toString(), { userId });
      const res = makeRes();
      await getStream(req, res as unknown as Response);

      expect(res._status).toBe(200);
      const url = (res._body as Record<string, unknown>).url as string;
      const t = new URL(url, 'http://localhost').searchParams.get('t');
      const claims = verifyStreamToken(t as string);
      expect(claims?.maxBitrateKbps).toBe(320);
    } finally {
      if (saved !== undefined) process.env.PREMIUM_USER_IDS = saved;
      else delete process.env.PREMIUM_USER_IDS;
    }
  });

  it('free user with dataSaver pref: token has maxBitrateKbps=96', async () => {
    const saved = process.env.PREMIUM_USER_IDS;
    delete process.env.PREMIUM_USER_IDS;
    try {
      const userId = 'datasaver-user';
      // Seed the prefs with dataSaver=true
      await UserMusicPreferencesModel.create({
        oxyUserId: userId,
        dataSaver: true,
      });

      const track = await seedTrack(hlsTrackFields());
      const req = makeReq(track._id.toString(), { userId });
      const res = makeRes();
      await getStream(req, res as unknown as Response);

      expect(res._status).toBe(200);
      const url = (res._body as Record<string, unknown>).url as string;
      const t = new URL(url, 'http://localhost').searchParams.get('t');
      const claims = verifyStreamToken(t as string);
      expect(claims?.maxBitrateKbps).toBe(96);
    } finally {
      if (saved !== undefined) process.env.PREMIUM_USER_IDS = saved;
      else delete process.env.PREMIUM_USER_IDS;
    }
  });
});

// ── getStreamKey tests ────────────────────────────────────────────────────────

describe('getStreamKey', () => {
  it('200: returns 16-byte raw key buffer via bearer auth', async () => {
    const track = await seedTrack();
    await seedKey(track._id.toString());

    const req = makeReq(track._id.toString());
    const res = makeRes();
    await getStreamKey(req, res as unknown as Response);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/octet-stream');
    expect(res._headers['Cache-Control']).toBe('no-store');
    expect(Buffer.isBuffer(res._body)).toBe(true);
    expect((res._body as Buffer).length).toBe(16);
    expect((res._body as Buffer).equals(Buffer.from(KEY_HEX, 'hex'))).toBe(true);
  });

  it('200: returns key via valid ?t= stream token bound to this track', async () => {
    const track = await seedTrack();
    await seedKey(track._id.toString());

    const token = mintStreamToken({
      trackId: track._id.toString(),
      userId: 'oxy-user-abc',
      maxBitrateKbps: 160,
    });

    const req = makeReq(track._id.toString(), { authed: false, query: { t: token } });
    const res = makeRes();
    await getStreamKey(req, res as unknown as Response);

    expect(res._status).toBe(200);
    expect((res._body as Buffer).length).toBe(16);
  });

  it('401: stream token bound to a DIFFERENT trackId is rejected', async () => {
    const track = await seedTrack();
    await seedKey(track._id.toString());

    const otherTrackId = new mongoose.Types.ObjectId().toString();
    const token = mintStreamToken({
      trackId: otherTrackId,
      userId: 'oxy-user-abc',
      maxBitrateKbps: 160,
    });

    const req = makeReq(track._id.toString(), { authed: false, query: { t: token } });
    const res = makeRes();
    await getStreamKey(req, res as unknown as Response);

    expect(res._status).toBe(401);
  });

  it('401: no bearer and no token', async () => {
    const track = await seedTrack();
    await seedKey(track._id.toString());

    const req = makeReq(track._id.toString(), { authed: false });
    const res = makeRes();
    await getStreamKey(req, res as unknown as Response);

    expect(res._status).toBe(401);
  });

  it('400: invalid ObjectId', async () => {
    const req = makeReq('not-an-objectid');
    const res = makeRes();
    await getStreamKey(req, res as unknown as Response);
    expect(res._status).toBe(400);
  });

  it('404: track not found', async () => {
    const absentId = new mongoose.Types.ObjectId().toString();
    const req = makeReq(absentId);
    const res = makeRes();
    await getStreamKey(req, res as unknown as Response);
    expect(res._status).toBe(404);
  });

  it('404: track exists but TrackKey missing', async () => {
    const track = await seedTrack();
    const req = makeReq(track._id.toString());
    const res = makeRes();
    await getStreamKey(req, res as unknown as Response);
    expect(res._status).toBe(404);
  });

  it('403: track is unavailable', async () => {
    const track = await seedTrack({ isAvailable: false });
    await seedKey(track._id.toString());

    const req = makeReq(track._id.toString());
    const res = makeRes();
    await getStreamKey(req, res as unknown as Response);
    expect(res._status).toBe(403);
  });

  it('403: track is copyright-removed', async () => {
    const track = await seedTrack({ copyrightRemoved: true });
    await seedKey(track._id.toString());

    const req = makeReq(track._id.toString());
    const res = makeRes();
    await getStreamKey(req, res as unknown as Response);
    expect(res._status).toBe(403);
  });
});

// ── getVariantPlaylist — bitrate cap enforcement ───────────────────────────────

describe('getVariantPlaylist — bitrate cap', () => {
  it('403: free token (cap=160) requesting 320 kbps variant', async () => {
    const track = await seedTrack(hlsTrackFields());
    const token = mintStreamToken({
      trackId: track._id.toString(),
      userId: 'oxy-user-abc',
      maxBitrateKbps: 160,
    });

    const req = makeReq(track._id.toString(), {
      authed: false,
      query: { t: token },
      variant: '320.m3u8',
    });
    const res = makeRes();
    await getVariantPlaylist(req, res as unknown as Response);

    expect(res._status).toBe(403);
    const body = res._body as Record<string, unknown>;
    expect(body.error).toBe('Quality not permitted');
  });

  it('200: free token (cap=160) requesting 160 kbps variant succeeds (up to S3 fetch)', async () => {
    // The controller will call buildVariantPlaylist which will call defaultFetchText (real S3).
    // We can't mock S3 here, so we expect the controller to reach the manifest build step
    // and fail with a non-403 error (S3 error → 500 or unhandled) — not a 403.
    // A cleaner approach: verify the 403 guard fires before any S3 call.
    // This test confirms 160 is NOT blocked by the cap gate (status !== 403).
    const track = await seedTrack(hlsTrackFields());
    const token = mintStreamToken({
      trackId: track._id.toString(),
      userId: 'oxy-user-abc',
      maxBitrateKbps: 160,
    });

    const req = makeReq(track._id.toString(), {
      authed: false,
      query: { t: token },
      variant: '160.m3u8',
    });
    const res = makeRes();
    // Will throw when trying to fetch from S3 — that's fine; we only check it's NOT 403
    try {
      await getVariantPlaylist(req, res as unknown as Response);
    } catch {
      // S3 call expected to fail in tests
    }
    expect(res._status).not.toBe(403);
  });
});
