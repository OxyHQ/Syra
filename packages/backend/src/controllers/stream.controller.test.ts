import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../test/mongo';
import { TrackModel } from '../models/Track';
import { TrackKeyModel } from '../models/TrackKey';
import { getStreamKey } from './stream.controller';
import type { AuthRequest } from '../middleware/auth';
import type { Response } from 'express';

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

function makeReq(trackId: string, authed = true): AuthRequest {
  return {
    params: { trackId },
    user: authed ? { id: 'oxy-user-abc' } : undefined,
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getStreamKey', () => {
  it('200: returns 16-byte raw key buffer with correct headers', async () => {
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

  it('401: no authenticated user', async () => {
    const track = await seedTrack();
    const req = makeReq(track._id.toString(), false);
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
