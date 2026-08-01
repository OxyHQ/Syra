import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import type { Response, NextFunction } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { connect, clear, disconnect } from '../test/mongo';
import { ArtistModel } from '../models/CatalogEntity';
import { ArtistClaimModel } from '../models/ArtistClaim';
import { createArtistClaim, resolveArtistClaim, listMyArtistClaims } from './artists.controller';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

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

const failNext: NextFunction = (err) => { throw err; };

function makeReq(params: Record<string, string>, userId: string, body: unknown = {}): AuthRequest {
  return { params, query: {}, body, user: { id: userId } } as unknown as AuthRequest;
}

async function makeClaimableArtist(overrides: Record<string, unknown> = {}): Promise<string> {
  const artist = await ArtistModel.create({
    name: `Contributed ${Math.random().toString(36).slice(2)}`,
    source: 'upload',
    origin: 'contributed',
    claimable: true,
    ...overrides,
  });
  return artist._id.toString();
}

// ── Submission ────────────────────────────────────────────────────────────────

describe('POST /api/artists/:id/claim', () => {
  /**
   * The invariant the whole flow exists for. A contributed profile is built from
   * a stranger's file tags; if claiming granted it, anyone could take the page of
   * any artist not yet on Syra, along with every recording other people
   * contributed to it.
   */
  it('NEVER auto-grants — it records a pending claim and changes nothing on the artist', async () => {
    const artistId = await makeClaimableArtist();

    const res = makeRes();
    await createArtistClaim(
      makeReq({ id: artistId }, 'claimant-1', { evidence: 'I am this artist, here is my label page' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(201);
    const { claim } = res._body as { claim: { id: string; status: string; oxyUserId: string } };
    expect(claim.status).toBe('pending');
    expect(claim.oxyUserId).toBe('claimant-1');

    const artist = await ArtistModel.findById(artistId).lean();
    expect(artist?.ownerOxyUserId).toBeUndefined();
    expect(artist?.claimedByOxyUserId).toBeUndefined();
    expect(artist?.claimable).toBe(true);
  });

  it('REJECTS a claim on an artist somebody already owns — it is not queued', async () => {
    const artistId = await makeClaimableArtist({ claimable: false, ownerOxyUserId: 'the-owner' });

    const res = makeRes();
    await createArtistClaim(
      makeReq({ id: artistId }, 'claimant-1', { evidence: 'let me in' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(409);
    expect(await ArtistClaimModel.countDocuments({})).toBe(0);
  });

  it('REJECTS a claim on an artist somebody already CLAIMED', async () => {
    const artistId = await makeClaimableArtist({ claimedByOxyUserId: 'the-claimant' });

    const res = makeRes();
    await createArtistClaim(
      makeReq({ id: artistId }, 'claimant-1', { evidence: 'let me in' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(409);
    expect(await ArtistClaimModel.countDocuments({})).toBe(0);
  });

  it('REJECTS a claimant who already has an artist profile of their own', async () => {
    await ArtistModel.create({ name: 'Mine Already', source: 'upload', ownerOxyUserId: 'claimant-1' });
    const artistId = await makeClaimableArtist();

    const res = makeRes();
    await createArtistClaim(
      makeReq({ id: artistId }, 'claimant-1', { evidence: 'also me' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(409);
    expect(await ArtistClaimModel.countDocuments({})).toBe(0);
  });

  it('REJECTS an empty evidence body', async () => {
    const artistId = await makeClaimableArtist();

    const res = makeRes();
    await createArtistClaim(
      makeReq({ id: artistId }, 'claimant-1', { evidence: '' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(400);
    expect(await ArtistClaimModel.countDocuments({})).toBe(0);
  });

  it('refuses a second OPEN claim from the same person on the same artist', async () => {
    const artistId = await makeClaimableArtist();
    const first = makeRes();
    await createArtistClaim(
      makeReq({ id: artistId }, 'claimant-1', { evidence: 'first attempt' }),
      first as unknown as Response,
      failNext,
    );
    expect(first._status).toBe(201);

    const second = makeRes();
    await createArtistClaim(
      makeReq({ id: artistId }, 'claimant-1', { evidence: 'second attempt' }),
      second as unknown as Response,
      failNext,
    );

    expect(second._status).toBe(409);
    expect(await ArtistClaimModel.countDocuments({ artistId })).toBe(1);
  });
});

// ── Resolution ────────────────────────────────────────────────────────────────

describe('POST /api/artist-claims/:id/resolve', () => {
  async function openClaim(artistId: string, userId: string): Promise<string> {
    const claim = await ArtistClaimModel.create({
      artistId,
      oxyUserId: userId,
      evidence: 'proof',
      status: 'pending',
    });
    return claim._id.toString();
  }

  it('APPROVAL is the only thing that writes ownership', async () => {
    const artistId = await makeClaimableArtist();
    const claimId = await openClaim(artistId, 'claimant-1');

    const res = makeRes();
    await resolveArtistClaim(
      makeReq({ id: claimId }, 'reviewer-1', { status: 'approved' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(200);
    const artist = await ArtistModel.findById(artistId).lean();
    expect(artist?.ownerOxyUserId).toBe('claimant-1');
    expect(artist?.claimedByOxyUserId).toBe('claimant-1');
    expect(artist?.claimable).toBe(false);

    const claim = await ArtistClaimModel.findById(claimId).lean();
    expect(claim?.status).toBe('approved');
    expect(claim?.resolvedBy).toBe('reviewer-1');
    expect(claim?.resolvedAt).toBeInstanceOf(Date);
  });

  it('REJECTION leaves the artist untouched and still claimable', async () => {
    const artistId = await makeClaimableArtist();
    const claimId = await openClaim(artistId, 'claimant-1');

    const res = makeRes();
    await resolveArtistClaim(
      makeReq({ id: claimId }, 'reviewer-1', { status: 'rejected', resolutionNote: 'no evidence' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(200);
    const artist = await ArtistModel.findById(artistId).lean();
    expect(artist?.ownerOxyUserId).toBeUndefined();
    expect(artist?.claimable).toBe(true);

    const claim = await ArtistClaimModel.findById(claimId).lean();
    expect(claim?.status).toBe('rejected');
    expect(claim?.resolutionNote).toBe('no evidence');
  });

  it('closes every OTHER open claim on a granted profile', async () => {
    const artistId = await makeClaimableArtist();
    const winner = await openClaim(artistId, 'claimant-1');
    const loser = await openClaim(artistId, 'claimant-2');

    await resolveArtistClaim(
      makeReq({ id: winner }, 'reviewer-1', { status: 'approved' }),
      makeRes() as unknown as Response,
      failNext,
    );

    const other = await ArtistClaimModel.findById(loser).lean();
    expect(other?.status).toBe('rejected');
    expect(other?.resolutionNote).toContain('approved');
  });

  it('refuses to resolve a claim twice', async () => {
    const artistId = await makeClaimableArtist();
    const claimId = await openClaim(artistId, 'claimant-1');

    await resolveArtistClaim(
      makeReq({ id: claimId }, 'reviewer-1', { status: 'rejected' }),
      makeRes() as unknown as Response,
      failNext,
    );

    const second = makeRes();
    await resolveArtistClaim(
      makeReq({ id: claimId }, 'reviewer-1', { status: 'approved' }),
      second as unknown as Response,
      failNext,
    );

    expect(second._status).toBe(409);
    const artist = await ArtistModel.findById(artistId).lean();
    expect(artist?.ownerOxyUserId).toBeUndefined();
  });

  /**
   * The queue is worked by more than one person. The grant is a conditional
   * update, so the second approval finds the precondition gone rather than
   * overwriting the first reviewer's decision.
   */
  it('refuses to grant a profile that was claimed while the claim sat in the queue', async () => {
    const artistId = await makeClaimableArtist();
    const claimId = await openClaim(artistId, 'claimant-1');

    await ArtistModel.updateOne(
      { _id: artistId },
      { $set: { ownerOxyUserId: 'somebody-faster', claimedByOxyUserId: 'somebody-faster', claimable: false } },
    );

    const res = makeRes();
    await resolveArtistClaim(
      makeReq({ id: claimId }, 'reviewer-1', { status: 'approved' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(409);
    const artist = await ArtistModel.findById(artistId).lean();
    expect(artist?.ownerOxyUserId).toBe('somebody-faster');
    const claim = await ArtistClaimModel.findById(claimId).lean();
    expect(claim?.status).toBe('pending');
  });

  it('refuses to approve when the claimant registered a profile in the meantime', async () => {
    const artistId = await makeClaimableArtist();
    const claimId = await openClaim(artistId, 'claimant-1');
    await ArtistModel.create({ name: 'Registered Later', source: 'upload', ownerOxyUserId: 'claimant-1' });

    const res = makeRes();
    await resolveArtistClaim(
      makeReq({ id: claimId }, 'reviewer-1', { status: 'approved' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(409);
    const artist = await ArtistModel.findById(artistId).lean();
    expect(artist?.ownerOxyUserId).toBeUndefined();
  });

  it('404s an unknown claim', async () => {
    const res = makeRes();
    await resolveArtistClaim(
      makeReq({ id: new mongoose.Types.ObjectId().toString() }, 'reviewer-1', { status: 'approved' }),
      res as unknown as Response,
      failNext,
    );
    expect(res._status).toBe(404);
  });

  it('refuses a body that tries to reopen a review as pending', async () => {
    const artistId = await makeClaimableArtist();
    const claimId = await openClaim(artistId, 'claimant-1');

    const res = makeRes();
    await resolveArtistClaim(
      makeReq({ id: claimId }, 'reviewer-1', { status: 'pending' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(400);
  });
});

// ── The claimant's own view ───────────────────────────────────────────────────

describe('GET /api/artist-claims/mine', () => {
  it('returns only the caller\'s claims', async () => {
    const artistId = await makeClaimableArtist();
    const otherArtistId = await makeClaimableArtist();
    await ArtistClaimModel.create({ artistId, oxyUserId: 'claimant-1', evidence: 'mine', status: 'pending' });
    await ArtistClaimModel.create({ artistId: otherArtistId, oxyUserId: 'claimant-2', evidence: 'theirs', status: 'pending' });

    const res = makeRes();
    await listMyArtistClaims(makeReq({}, 'claimant-1'), res as unknown as Response, failNext);

    const { claims } = res._body as { claims: { oxyUserId: string }[] };
    expect(claims).toHaveLength(1);
    expect(claims[0]?.oxyUserId).toBe('claimant-1');
  });
});
