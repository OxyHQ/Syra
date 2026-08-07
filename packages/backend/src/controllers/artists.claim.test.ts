import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import type { Response, NextFunction } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { normalizeNameKey } from '@syra/shared-types';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities } from '../db/schema/catalog';
import { artistClaims } from '../db/schema/creators';
import { createArtistClaim, resolveArtistClaim, listMyArtistClaims } from './artists.controller';

/**
 * BOTH databases: the artist profile a claim GRANTS is Postgres, the claim
 * itself is `artist_claims` — Task 13's table, still Mongoose. The grant is the
 * one write that has to be atomic against a concurrent claim, and it is the
 * Postgres half that carries that guarantee.
 */
beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

/** The artist row a claim targets, by id. */
/** A claim row, read back directly rather than through a production helper. */
async function readClaim(id: string) {
  const [claim] = await getDb().select().from(artistClaims).where(eq(artistClaims.id, id));
  return claim;
}

async function countClaims(artistId?: string): Promise<number> {
  const rows = await getDb()
    .select({ id: artistClaims.id })
    .from(artistClaims)
    .where(artistId ? eq(artistClaims.artistId, artistId) : undefined);
  return rows.length;
}

async function readArtist(id: string) {
  const [row] = await getDb()
    .select()
    .from(catalogEntities)
    .where(eq(catalogEntities.id, id))
    .limit(1);
  return row;
}

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

async function makeClaimableArtist(
  overrides: Partial<typeof catalogEntities.$inferInsert> = {}
): Promise<string> {
  const name = `Contributed ${uuidv7()}`;
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name,
      nameKey: normalizeNameKey(name),
      source: 'upload',
      origin: 'contributed',
      claimable: true,
      ...overrides,
    })
    .returning({ id: catalogEntities.id });

  if (!artist) throw new Error('makeClaimableArtist: insert returned no row');
  return artist.id;
}

/** An artist already owned by someone — the conflict fixture. */
async function makeOwnedArtist(name: string, ownerOxyUserId: string): Promise<void> {
  await getDb().insert(catalogEntities).values({
    type: 'artist',
    name,
    nameKey: normalizeNameKey(name),
    source: 'upload',
    ownerOxyUserId,
  });
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

    // `null`, not `undefined`: Mongo simply had no key for an unset field and
    // Postgres returns an explicit null. Both columns are asserted, because
    // "nobody holds this profile" is what the grant's WHERE clause tests.
    const artist = await readArtist(artistId);
    expect(artist?.ownerOxyUserId).toBeNull();
    expect(artist?.claimedByOxyUserId).toBeNull();
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
    expect(await countClaims()).toBe(0);
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
    expect(await countClaims()).toBe(0);
  });

  it('REJECTS a claimant who already has an artist profile of their own', async () => {
    await makeOwnedArtist('Mine Already', 'claimant-1');
    const artistId = await makeClaimableArtist();

    const res = makeRes();
    await createArtistClaim(
      makeReq({ id: artistId }, 'claimant-1', { evidence: 'also me' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(409);
    expect(await countClaims()).toBe(0);
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
    expect(await countClaims()).toBe(0);
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
    expect(await countClaims(artistId)).toBe(1);
  });
});

// ── Resolution ────────────────────────────────────────────────────────────────

describe('POST /api/artist-claims/:id/resolve', () => {
  async function openClaim(artistId: string, userId: string): Promise<string> {
    const [claim] = await getDb()
      .insert(artistClaims)
      .values({ artistId, oxyUserId: userId, evidence: 'proof', status: 'pending' })
      .returning({ id: artistClaims.id });
    return claim.id;
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
    const artist = await readArtist(artistId);
    expect(artist?.ownerOxyUserId).toBe('claimant-1');
    expect(artist?.claimedByOxyUserId).toBe('claimant-1');
    expect(artist?.claimable).toBe(false);

    const claim = await readClaim(claimId);
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
    const artist = await readArtist(artistId);
    expect(artist?.ownerOxyUserId).toBeNull();
    expect(artist?.claimable).toBe(true);

    const claim = await readClaim(claimId);
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

    const other = await readClaim(loser);
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
    const artist = await readArtist(artistId);
    expect(artist?.ownerOxyUserId).toBeNull();
  });

  /**
   * The queue is worked by more than one person. The grant is a conditional
   * update, so the second approval finds the precondition gone rather than
   * overwriting the first reviewer's decision.
   */
  it('refuses to grant a profile that was claimed while the claim sat in the queue', async () => {
    const artistId = await makeClaimableArtist();
    const claimId = await openClaim(artistId, 'claimant-1');

    await getDb()
      .update(catalogEntities)
      .set({
        ownerOxyUserId: 'somebody-faster',
        claimedByOxyUserId: 'somebody-faster',
        claimable: false,
      })
      .where(eq(catalogEntities.id, artistId));

    const res = makeRes();
    await resolveArtistClaim(
      makeReq({ id: claimId }, 'reviewer-1', { status: 'approved' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(409);
    const artist = await readArtist(artistId);
    expect(artist?.ownerOxyUserId).toBe('somebody-faster');
    const claim = await readClaim(claimId);
    expect(claim?.status).toBe('pending');
  });

  it('refuses to approve when the claimant registered a profile in the meantime', async () => {
    const artistId = await makeClaimableArtist();
    const claimId = await openClaim(artistId, 'claimant-1');
    await makeOwnedArtist('Registered Later', 'claimant-1');

    const res = makeRes();
    await resolveArtistClaim(
      makeReq({ id: claimId }, 'reviewer-1', { status: 'approved' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(409);
    const artist = await readArtist(artistId);
    expect(artist?.ownerOxyUserId).toBeNull();
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
    await getDb().insert(artistClaims).values([
      { artistId, oxyUserId: 'claimant-1', evidence: 'mine', status: 'pending' },
      { artistId: otherArtistId, oxyUserId: 'claimant-2', evidence: 'theirs', status: 'pending' },
    ]);

    const res = makeRes();
    await listMyArtistClaims(makeReq({}, 'claimant-1'), res as unknown as Response, failNext);

    const { claims } = res._body as { claims: { oxyUserId: string }[] };
    expect(claims).toHaveLength(1);
    expect(claims[0]?.oxyUserId).toBe('claimant-1');
  });
});
