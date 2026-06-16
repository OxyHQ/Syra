import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../test/mongo';
import { TrackModel } from '../models/Track';
import { ArtistModel } from '../models/Artist';
import { makeSourcesController } from './sources.controller';
import type { ExternalTrack } from '@syra/shared-types';
import type { AuthRequest } from '../middleware/auth';
import type { Response } from 'express';
import type { MusicSourceConnector } from '../services/sources/MusicSourceConnector';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

// ── Fake req/res helpers ──────────────────────────────────────────────────────

interface CapturedRes {
  _status: number;
  _body: unknown;
  status(code: number): CapturedRes;
  json(body: unknown): CapturedRes;
}

function makeRes(): CapturedRes {
  const res: CapturedRes = {
    _status: 200,
    _body: undefined,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

function makeGetReq(query: Record<string, string>, authed = false, userId = ''): AuthRequest {
  return {
    query,
    user: authed ? { id: userId } : undefined,
  } as unknown as AuthRequest;
}

function makePostReq(body: unknown, authed = true, userId = 'user-123'): AuthRequest {
  return {
    body,
    user: authed ? { id: userId } : undefined,
  } as unknown as AuthRequest;
}

// ── Fake connector ────────────────────────────────────────────────────────────

function makeFakeConnector(
  tracks: ExternalTrack[] = [],
  shouldThrow = false,
): MusicSourceConnector {
  return {
    provider: 'audius' as const,
    search: async (_query: string, _limit?: number): Promise<ExternalTrack[]> => {
      if (shouldThrow) throw new Error('Audius API error');
      return tracks;
    },
  };
}

// ── Sample ExternalTrack ──────────────────────────────────────────────────────

function makeAudiusTrack(overrides: Partial<ExternalTrack> = {}): ExternalTrack {
  return {
    provider: 'audius',
    externalId: 'aud-123',
    title: 'Test Track',
    artists: [{ name: 'Test Artist', externalId: 'aud-artist-1' }],
    durationSec: 180,
    streamUrl: 'https://discoveryprovider.audius.co/v1/tracks/aud-123/stream?app_name=Syra',
    ...overrides,
  };
}

// ── searchAudius ──────────────────────────────────────────────────────────────

describe('searchAudius', () => {
  it('200: returns results from connector', async () => {
    const tracks = [makeAudiusTrack(), makeAudiusTrack({ externalId: 'aud-456', title: 'Another' })];
    const { searchAudius } = makeSourcesController({ connector: makeFakeConnector(tracks) });

    const req = makeGetReq({ q: 'test' });
    const res = makeRes();
    await searchAudius(req, res as unknown as Response);

    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(Array.isArray(body.results)).toBe(true);
    expect((body.results as ExternalTrack[]).length).toBe(2);
    expect((body.results as ExternalTrack[])[0].externalId).toBe('aud-123');
  });

  it('400: missing q parameter', async () => {
    const { searchAudius } = makeSourcesController({ connector: makeFakeConnector() });

    const req = makeGetReq({});
    const res = makeRes();
    await searchAudius(req, res as unknown as Response);

    expect(res._status).toBe(400);
    const body = res._body as Record<string, string>;
    expect(body.error).toBeTruthy();
  });

  it('400: empty q parameter', async () => {
    const { searchAudius } = makeSourcesController({ connector: makeFakeConnector() });

    const req = makeGetReq({ q: '   ' });
    const res = makeRes();
    await searchAudius(req, res as unknown as Response);

    expect(res._status).toBe(400);
  });

  it('502: connector throws → masked error response', async () => {
    const { searchAudius } = makeSourcesController({ connector: makeFakeConnector([], true) });

    const req = makeGetReq({ q: 'test' });
    const res = makeRes();
    await searchAudius(req, res as unknown as Response);

    expect(res._status).toBe(502);
    const body = res._body as Record<string, string>;
    expect(body.error).toBe('Audius search failed');
  });

  it('clamps limit to 1–50 (below → 1)', async () => {
    let capturedLimit: number | undefined;
    const connector: MusicSourceConnector = {
      provider: 'audius' as const,
      search: async (_q: string, limit?: number) => { capturedLimit = limit; return []; },
    };
    const { searchAudius } = makeSourcesController({ connector });

    const req = makeGetReq({ q: 'test', limit: '0' });
    const res = makeRes();
    await searchAudius(req, res as unknown as Response);

    expect(res._status).toBe(200);
    expect(capturedLimit).toBe(1);
  });

  it('clamps limit to 1–50 (above → 50)', async () => {
    let capturedLimit: number | undefined;
    const connector: MusicSourceConnector = {
      provider: 'audius' as const,
      search: async (_q: string, limit?: number) => { capturedLimit = limit; return []; },
    };
    const { searchAudius } = makeSourcesController({ connector });

    const req = makeGetReq({ q: 'test', limit: '999' });
    const res = makeRes();
    await searchAudius(req, res as unknown as Response);

    expect(res._status).toBe(200);
    expect(capturedLimit).toBe(50);
  });

  it('default limit is 20 when omitted', async () => {
    let capturedLimit: number | undefined;
    const connector: MusicSourceConnector = {
      provider: 'audius' as const,
      search: async (_q: string, limit?: number) => { capturedLimit = limit; return []; },
    };
    const { searchAudius } = makeSourcesController({ connector });

    const req = makeGetReq({ q: 'test' });
    const res = makeRes();
    await searchAudius(req, res as unknown as Response);

    expect(capturedLimit).toBe(20);
  });
});

// ── addAudiusTrack ────────────────────────────────────────────────────────────

describe('addAudiusTrack', () => {
  it('200 created=true: authed + valid body → track and artist in catalog', async () => {
    const { addAudiusTrack } = makeSourcesController({ connector: makeFakeConnector() });

    const external = makeAudiusTrack();
    const req = makePostReq(external);
    const res = makeRes();
    await addAudiusTrack(req, res as unknown as Response);

    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect((body.track as Record<string, unknown>).title).toBe('Test Track');
    expect(body.created).toBe(true);

    // Verify catalog side-effects
    const dbTrack = await TrackModel.findOne({ 'externalIds.audiusId': 'aud-123' });
    expect(dbTrack).not.toBeNull();
    expect(dbTrack?.streamUrl).toBe(external.streamUrl);
    expect(dbTrack?.status).toBe('ready');

    const dbArtist = await ArtistModel.findOne({ 'externalIds.audiusId': 'aud-artist-1' });
    expect(dbArtist).not.toBeNull();
    expect(dbArtist?.name).toBe('Test Artist');
  });

  it('200 created=false: second add of same externalId does not duplicate', async () => {
    const { addAudiusTrack } = makeSourcesController({ connector: makeFakeConnector() });

    const external = makeAudiusTrack();
    const req1 = makePostReq(external);
    const res1 = makeRes();
    await addAudiusTrack(req1, res1 as unknown as Response);
    expect(res1._status).toBe(200);
    expect((res1._body as Record<string, unknown>).created).toBe(true);

    const req2 = makePostReq(external);
    const res2 = makeRes();
    await addAudiusTrack(req2, res2 as unknown as Response);
    expect(res2._status).toBe(200);
    expect((res2._body as Record<string, unknown>).created).toBe(false);

    // Still only one track in catalog
    const count = await TrackModel.countDocuments({ 'externalIds.audiusId': 'aud-123' });
    expect(count).toBe(1);
  });

  it('401: no auth → rejected', async () => {
    const { addAudiusTrack } = makeSourcesController({ connector: makeFakeConnector() });

    const req = makePostReq(makeAudiusTrack(), false);
    const res = makeRes();
    await addAudiusTrack(req, res as unknown as Response);

    expect(res._status).toBe(401);
  });

  it('400: provider is not audius', async () => {
    const { addAudiusTrack } = makeSourcesController({ connector: makeFakeConnector() });

    const external = makeAudiusTrack({ provider: 'cc' as 'audius' });
    const req = makePostReq(external);
    const res = makeRes();
    await addAudiusTrack(req, res as unknown as Response);

    expect(res._status).toBe(400);
  });

  it('400: missing externalId', async () => {
    const { addAudiusTrack } = makeSourcesController({ connector: makeFakeConnector() });

    const external = makeAudiusTrack({ externalId: '' });
    const req = makePostReq(external);
    const res = makeRes();
    await addAudiusTrack(req, res as unknown as Response);

    expect(res._status).toBe(400);
  });

  it('400: missing title', async () => {
    const { addAudiusTrack } = makeSourcesController({ connector: makeFakeConnector() });

    const external = makeAudiusTrack({ title: '' });
    const req = makePostReq(external);
    const res = makeRes();
    await addAudiusTrack(req, res as unknown as Response);

    expect(res._status).toBe(400);
  });

  it('400: missing artists', async () => {
    const { addAudiusTrack } = makeSourcesController({ connector: makeFakeConnector() });

    const external = makeAudiusTrack({ artists: [] });
    const req = makePostReq(external);
    const res = makeRes();
    await addAudiusTrack(req, res as unknown as Response);

    expect(res._status).toBe(400);
  });

  it('400: non-object body', async () => {
    const { addAudiusTrack } = makeSourcesController({ connector: makeFakeConnector() });

    const req = makePostReq('not-an-object');
    const res = makeRes();
    await addAudiusTrack(req, res as unknown as Response);

    expect(res._status).toBe(400);
  });
});
