import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../test/mongo';
import { LyricsModel } from '../models/Lyrics';
import { getLyrics } from './lyrics.controller';
import type { Request, Response } from 'express';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

// ── Fake req/res helpers ──────────────────────────────────────────────────────

interface CapturedRes {
  _status: number;
  _body: unknown;
  _headers: Record<string, string>;
  status(code: number): CapturedRes;
  set(name: string, value: string): CapturedRes;
  json(body: unknown): CapturedRes;
}

function makeRes(): CapturedRes {
  const res: CapturedRes = {
    _status: 200,
    _body: undefined,
    _headers: {},
    status(code) { this._status = code; return this; },
    set(name, value) { this._headers[name] = value; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

function makeReq(trackId: string): Request {
  return { params: { trackId } } as unknown as Request;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/lyrics/:trackId', () => {
  it('returns 400 for an invalid ObjectId', async () => {
    const req = makeReq('not-an-objectid');
    const res = makeRes();

    await getLyrics(req, res as unknown as Response);

    expect(res._status).toBe(400);
    expect((res._body as Record<string, string>).error).toContain('Invalid');
  });

  it('returns 200 with lyrics when a cached doc exists', async () => {
    const trackId = new mongoose.Types.ObjectId().toString();
    await LyricsModel.create({
      trackId,
      synced: true,
      lines: [{ timeMs: 1000, text: 'hello' }],
      source: 'lrclib',
    });

    const req = makeReq(trackId);
    const res = makeRes();

    await getLyrics(req, res as unknown as Response);

    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(body.trackId).toBe(trackId);
    expect(body.synced).toBe(true);
    expect((body.lines as unknown[]).length).toBe(1);
  });

  it('returns 404 when no lyrics and no track exist', async () => {
    const trackId = new mongoose.Types.ObjectId().toString();
    const req = makeReq(trackId);
    const res = makeRes();

    await getLyrics(req, res as unknown as Response);

    expect(res._status).toBe(404);
    expect((res._body as Record<string, string>).error).toContain('not found');
  });
});
