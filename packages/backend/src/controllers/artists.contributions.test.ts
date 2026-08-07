import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import type { Response, NextFunction } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { normalizeNameKey } from '@syra/shared-types';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities, tracks } from '../db/schema/catalog';
import { copyrightReports } from '../db/schema/creators';
import { contributionAttestations } from '../db/schema/creators';
import {
  getMyContributions,
  resolveMyContribution,
  updateMyContributionSettings,
} from './artists.controller';

/**
 * A "contribution" is a `tracks` row PLUS a `contribution_attestations` row, and
 * neither alone means anything — both Postgres since Task 13. It was one
 * `$lookup` under Mongo and it is three round trips now, and these tests are
 * what say the answer did not change across both moves.
 */
beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

async function readTrack(id: string) {
  const [row] = await getDb().select().from(tracks).where(eq(tracks.id, id)).limit(1);
  return row;
}

async function readArtist(id: string) {
  const [row] = await getDb()
    .select()
    .from(catalogEntities)
    .where(eq(catalogEntities.id, id))
    .limit(1);
  return row;
}

/** An artist owned by somebody, for the cross-profile isolation cases. */
async function makeArtistOwnedBy(name: string, ownerOxyUserId: string): Promise<string> {
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name,
      nameKey: normalizeNameKey(`${name} ${uuidv7()}`),
      source: 'upload',
      ownerOxyUserId,
    })
    .returning({ id: catalogEntities.id });

  if (!artist) throw new Error('makeArtistOwnedBy: insert returned no row');
  return artist.id;
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

function makeReq(
  params: Record<string, string>,
  userId: string,
  body: unknown = {},
): AuthRequest {
  return { params, query: {}, body, user: { id: userId } } as unknown as AuthRequest;
}

const OWNER = 'the-artist';

async function makeOwnedArtist(): Promise<string> {
  const name = `Claimed ${uuidv7()}`;
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name,
      nameKey: normalizeNameKey(name),
      source: 'upload',
      origin: 'contributed',
      ownerOxyUserId: OWNER,
      claimedByOxyUserId: OWNER,
      claimable: false,
    })
    .returning({ id: catalogEntities.id });

  if (!artist) throw new Error('makeOwnedArtist: insert returned no row');
  return artist.id;
}

async function makeTrack(artistId: string, title: string): Promise<string> {
  const [track] = await getDb()
    .insert(tracks)
    .values({
      title,
      artistId,
      artistName: 'Whoever',
      duration: 180,
      source: 'upload',
      status: 'ready',
    })
    .returning({ id: tracks.id });

  if (!track) throw new Error('makeTrack: insert returned no row');
  return track.id;
}

async function attest(trackId: string, uploader: string): Promise<void> {
  await getDb().insert(contributionAttestations).values({
    trackId,
    uploaderOxyUserId: uploader,
    statement: 'I may distribute this recording',
    acceptedAt: new Date(),
  });
}

// ── Listing ───────────────────────────────────────────────────────────────────

describe('GET /api/artists/me/contributions', () => {
  it('lists ONLY the tracks somebody else contributed, with the uploader', async () => {
    const artistId = await makeOwnedArtist();
    const contributed = await makeTrack(artistId, 'Someone Elses Upload');
    await makeTrack(artistId, 'My Own Upload');
    await attest(contributed, 'a-stranger');

    const res = makeRes();
    await getMyContributions(makeReq({}, OWNER), res as unknown as Response, failNext);

    const body = res._body as {
      contributions: { trackId: string; title: string; uploaderOxyUserId?: string }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.contributions).toHaveLength(1);
    expect(body.contributions[0]?.trackId).toBe(contributed);
    expect(body.contributions[0]?.uploaderOxyUserId).toBe('a-stranger');
  });

  it('never leaks another artist\'s contributions', async () => {
    const mine = await makeOwnedArtist();
    const theirs = await makeArtistOwnedBy('Other Artist', 'somebody-else');
    const theirTrack = await makeTrack(theirs, 'Their Contributed Song');
    await attest(theirTrack, 'a-stranger');
    const myTrack = await makeTrack(mine, 'My Contributed Song');
    await attest(myTrack, 'a-stranger');

    const res = makeRes();
    await getMyContributions(makeReq({}, OWNER), res as unknown as Response, failNext);

    const body = res._body as { contributions: { trackId: string }[] };
    expect(body.contributions.map((row) => row.trackId)).toEqual([myTrack]);
  });

  it('404s when the caller has no artist profile', async () => {
    const res = makeRes();
    await getMyContributions(makeReq({}, 'nobody'), res as unknown as Response, failNext);
    expect(res._status).toBe(404);
  });
});

// ── Keep / unpublish / takedown ───────────────────────────────────────────────

describe('PATCH /api/artists/me/contributions/:trackId', () => {
  it('unpublish hides the track, keep puts it back', async () => {
    const artistId = await makeOwnedArtist();
    const trackId = await makeTrack(artistId, 'Contributed');
    await attest(trackId, 'a-stranger');

    await resolveMyContribution(
      makeReq({ trackId }, OWNER, { action: 'unpublish' }),
      makeRes() as unknown as Response,
      failNext,
    );
    expect((await readTrack(trackId))?.isAvailable).toBe(false);

    await resolveMyContribution(
      makeReq({ trackId }, OWNER, { action: 'keep' }),
      makeRes() as unknown as Response,
      failNext,
    );
    expect((await readTrack(trackId))?.isAvailable).toBe(true);
  });

  it('takedown records a resolved report, removes the track, and strikes the uploader', async () => {
    const artistId = await makeOwnedArtist();
    const uploaderArtistId = await makeArtistOwnedBy('The Uploader', 'a-stranger');
    const trackId = await makeTrack(artistId, 'Contributed');
    await attest(trackId, 'a-stranger');

    const res = makeRes();
    await resolveMyContribution(
      makeReq({ trackId }, OWNER, { action: 'takedown', reason: 'That is my recording' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(200);

    const track = await readTrack(trackId);
    expect(track?.copyrightRemoved).toBe(true);
    expect(track?.isAvailable).toBe(false);
    expect(track?.removedBy).toBe(OWNER);

    // The audit trail: a takedown with no report behind it is an unexplained
    // disappearance.
    const [report] = await getDb()
      .select()
      .from(copyrightReports)
      .where(eq(copyrightReports.trackId, trackId))
      .limit(1);
    expect(report?.status).toBe('approved');
    expect(report?.reporterOxyUserId).toBe(OWNER);
    // The report id really exists, asserted before it is compared — otherwise
    // `undefined === undefined` would pass with no report written at all.
    expect(typeof report?.id).toBe('string');
    expect(track?.copyrightReportId).toBe(report?.id ?? null);

    // Struck the contributor, not the artist who asked for the takedown.
    const uploader = await readArtist(uploaderArtistId);
    expect(uploader?.strikeCount).toBe(1);
    const victim = await readArtist(artistId);
    expect(victim?.strikeCount ?? 0).toBe(0);
  });

  it('refuses to republish a track that was taken down for copyright', async () => {
    const artistId = await makeOwnedArtist();
    const trackId = await makeTrack(artistId, 'Contributed');
    await attest(trackId, 'a-stranger');
    await getDb()
      .update(tracks)
      .set({ copyrightRemoved: true, isAvailable: false })
      .where(eq(tracks.id, trackId));

    const res = makeRes();
    await resolveMyContribution(
      makeReq({ trackId }, OWNER, { action: 'keep' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(409);
    expect((await readTrack(trackId))?.isAvailable).toBe(false);
  });

  it('404s a track on the profile that nobody contributed — that is the creator\'s own catalog', async () => {
    const artistId = await makeOwnedArtist();
    const trackId = await makeTrack(artistId, 'My Own Upload');

    const res = makeRes();
    await resolveMyContribution(
      makeReq({ trackId }, OWNER, { action: 'unpublish' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(404);
    expect((await readTrack(trackId))?.isAvailable).toBe(true);
  });

  it('404s a track belonging to another artist — no cross-profile reach', async () => {
    await makeOwnedArtist();
    const other = await makeArtistOwnedBy('Other Artist', 'somebody-else');
    const trackId = await makeTrack(other, 'Not Mine');
    await attest(trackId, 'a-stranger');

    const res = makeRes();
    await resolveMyContribution(
      makeReq({ trackId }, OWNER, { action: 'takedown' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(404);
    expect((await readTrack(trackId))?.copyrightRemoved).toBe(false);
  });

  it('rejects an unknown action', async () => {
    const artistId = await makeOwnedArtist();
    const trackId = await makeTrack(artistId, 'Contributed');
    await attest(trackId, 'a-stranger');

    const res = makeRes();
    await resolveMyContribution(
      makeReq({ trackId }, OWNER, { action: 'delete-everything' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(400);
  });

  it('404s an id that is not an ObjectId', async () => {
    await makeOwnedArtist();
    const res = makeRes();
    await resolveMyContribution(
      makeReq({ trackId: 'not-an-id' }, OWNER, { action: 'unpublish' }),
      res as unknown as Response,
      failNext,
    );
    expect(res._status).toBe(404);
  });
});

// ── The contributions switch ──────────────────────────────────────────────────

describe('PATCH /api/artists/me/contribution-settings', () => {
  it('opens and closes the profile to contributions', async () => {
    const artistId = await makeOwnedArtist();

    await updateMyContributionSettings(
      makeReq({}, OWNER, { acceptsContributions: true }),
      makeRes() as unknown as Response,
      failNext,
    );
    expect((await readArtist(artistId))?.acceptsContributions).toBe(true);

    await updateMyContributionSettings(
      makeReq({}, OWNER, { acceptsContributions: false }),
      makeRes() as unknown as Response,
      failNext,
    );
    expect((await readArtist(artistId))?.acceptsContributions).toBe(false);
  });

  it('rejects a non-boolean', async () => {
    await makeOwnedArtist();
    const res = makeRes();
    await updateMyContributionSettings(
      makeReq({}, OWNER, { acceptsContributions: 'yes' }),
      res as unknown as Response,
      failNext,
    );
    expect(res._status).toBe(400);
  });

  it('404s when the caller has no artist profile', async () => {
    const res = makeRes();
    await updateMyContributionSettings(
      makeReq({}, 'nobody', { acceptsContributions: true }),
      res as unknown as Response,
      failNext,
    );
    expect(res._status).toBe(404);
  });
});

// A guard against the aggregation silently matching nothing: if the `$lookup`
// broke, every test above would still pass by returning an empty list, so one
// case asserts the join finds a row it must find.
describe('contribution lookup vacuity floor', () => {
  it('finds a contribution whose attestation exists', async () => {
    const artistId = await makeOwnedArtist();
    const trackId = await makeTrack(artistId, 'Definitely Contributed');
    await attest(trackId, 'a-stranger');

    expect(
      await getDb()
        .select({ id: contributionAttestations.id })
        .from(contributionAttestations)
        .where(eq(contributionAttestations.trackId, trackId))
    ).toHaveLength(1);

    const res = makeRes();
    await getMyContributions(makeReq({}, OWNER), res as unknown as Response, failNext);
    const body = res._body as { contributions: unknown[]; total: number };
    expect(body.total).toBe(1);
    expect(body.contributions).toHaveLength(1);
  });

  it('is scoped by artist, not global — a foreign attestation does not leak in', async () => {
    await makeOwnedArtist();
    const foreign = await makeArtistOwnedBy('Foreign', 'someone');
    const foreignTrack = await makeTrack(foreign, 'Foreign Contributed');
    await attest(foreignTrack, 'a-stranger');

    const res = makeRes();
    await getMyContributions(makeReq({}, OWNER), res as unknown as Response, failNext);
    const body = res._body as { total: number };
    expect(body.total).toBe(0);
    expect(
      await getDb().select({ id: contributionAttestations.id }).from(contributionAttestations)
    ).toHaveLength(1);
  });
});

describe('takedown from the panel needs a real track', () => {
  it('404s an unknown track id', async () => {
    await makeOwnedArtist();
    const res = makeRes();
    await resolveMyContribution(
      // A uuid v7 — the shape `generatedId()` mints, so this exercises the
      // 404 an unknown id in the LIVE space takes, not the one a rejected id
      // shape takes.
      makeReq({ trackId: uuidv7() }, OWNER, { action: 'takedown' }),
      res as unknown as Response,
      failNext,
    );
    expect(res._status).toBe(404);
    // No orphan report: the 404 happens before the audit row is written, so a
    // report here would describe a takedown that never occurred.
    const reports = await getDb().select({ id: copyrightReports.id }).from(copyrightReports);
    expect(reports).toEqual([]);
  });
});
