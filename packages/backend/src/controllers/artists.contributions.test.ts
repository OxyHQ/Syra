import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import type { Response, NextFunction } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { connect, clear, disconnect } from '../test/mongo';
import { ArtistModel } from '../models/CatalogEntity';
import { TrackModel } from '../models/Track';
import { ContributionAttestationModel } from '../models/ContributionAttestation';
import { CopyrightReportModel } from '../models/CopyrightReport';
import {
  getMyContributions,
  resolveMyContribution,
  updateMyContributionSettings,
} from './artists.controller';

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

function makeReq(
  params: Record<string, string>,
  userId: string,
  body: unknown = {},
): AuthRequest {
  return { params, query: {}, body, user: { id: userId } } as unknown as AuthRequest;
}

const OWNER = 'the-artist';

async function makeOwnedArtist(): Promise<string> {
  const artist = await ArtistModel.create({
    name: `Claimed ${Math.random().toString(36).slice(2)}`,
    source: 'upload',
    origin: 'contributed',
    ownerOxyUserId: OWNER,
    claimedByOxyUserId: OWNER,
    claimable: false,
  });
  return artist._id.toString();
}

async function makeTrack(artistId: string, title: string): Promise<string> {
  const track = await TrackModel.create({
    title,
    artistId,
    artistName: 'Whoever',
    duration: 180,
    source: 'upload',
    status: 'ready',
  });
  return track._id.toString();
}

async function attest(trackId: string, uploader: string): Promise<void> {
  await ContributionAttestationModel.create({
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
    const theirs = await ArtistModel.create({
      name: 'Other Artist', source: 'upload', ownerOxyUserId: 'somebody-else',
    });
    const theirTrack = await makeTrack(theirs._id.toString(), 'Their Contributed Song');
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
    expect((await TrackModel.findById(trackId).lean())?.isAvailable).toBe(false);

    await resolveMyContribution(
      makeReq({ trackId }, OWNER, { action: 'keep' }),
      makeRes() as unknown as Response,
      failNext,
    );
    expect((await TrackModel.findById(trackId).lean())?.isAvailable).toBe(true);
  });

  it('takedown records a resolved report, removes the track, and strikes the uploader', async () => {
    const artistId = await makeOwnedArtist();
    const uploaderArtist = await ArtistModel.create({
      name: 'The Uploader', source: 'upload', ownerOxyUserId: 'a-stranger',
    });
    const trackId = await makeTrack(artistId, 'Contributed');
    await attest(trackId, 'a-stranger');

    const res = makeRes();
    await resolveMyContribution(
      makeReq({ trackId }, OWNER, { action: 'takedown', reason: 'That is my recording' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(200);

    const track = await TrackModel.findById(trackId).lean();
    expect(track?.copyrightRemoved).toBe(true);
    expect(track?.isAvailable).toBe(false);
    expect(track?.removedBy).toBe(OWNER);

    // The audit trail: a takedown with no report behind it is an unexplained
    // disappearance.
    const report = await CopyrightReportModel.findOne({ trackId }).lean();
    expect(report?.status).toBe('approved');
    expect(report?.reporterOxyUserId).toBe(OWNER);
    expect(track?.copyrightReportId).toBe(report?._id.toString());

    // Struck the contributor, not the artist who asked for the takedown.
    const uploader = await ArtistModel.findById(uploaderArtist._id).lean();
    expect(uploader?.strikeCount).toBe(1);
    const victim = await ArtistModel.findById(artistId).lean();
    expect(victim?.strikeCount ?? 0).toBe(0);
  });

  it('refuses to republish a track that was taken down for copyright', async () => {
    const artistId = await makeOwnedArtist();
    const trackId = await makeTrack(artistId, 'Contributed');
    await attest(trackId, 'a-stranger');
    await TrackModel.updateOne({ _id: trackId }, { copyrightRemoved: true, isAvailable: false });

    const res = makeRes();
    await resolveMyContribution(
      makeReq({ trackId }, OWNER, { action: 'keep' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(409);
    expect((await TrackModel.findById(trackId).lean())?.isAvailable).toBe(false);
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
    expect((await TrackModel.findById(trackId).lean())?.isAvailable).toBe(true);
  });

  it('404s a track belonging to another artist — no cross-profile reach', async () => {
    await makeOwnedArtist();
    const other = await ArtistModel.create({
      name: 'Other Artist', source: 'upload', ownerOxyUserId: 'somebody-else',
    });
    const trackId = await makeTrack(other._id.toString(), 'Not Mine');
    await attest(trackId, 'a-stranger');

    const res = makeRes();
    await resolveMyContribution(
      makeReq({ trackId }, OWNER, { action: 'takedown' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(404);
    expect((await TrackModel.findById(trackId).lean())?.copyrightRemoved).toBe(false);
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
    expect((await ArtistModel.findById(artistId).lean())?.acceptsContributions).toBe(true);

    await updateMyContributionSettings(
      makeReq({}, OWNER, { acceptsContributions: false }),
      makeRes() as unknown as Response,
      failNext,
    );
    expect((await ArtistModel.findById(artistId).lean())?.acceptsContributions).toBe(false);
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

    expect(await ContributionAttestationModel.countDocuments({ trackId })).toBe(1);

    const res = makeRes();
    await getMyContributions(makeReq({}, OWNER), res as unknown as Response, failNext);
    const body = res._body as { contributions: unknown[]; total: number };
    expect(body.total).toBe(1);
    expect(body.contributions).toHaveLength(1);
  });

  it('is scoped by artist, not global — a foreign attestation does not leak in', async () => {
    await makeOwnedArtist();
    const foreign = await ArtistModel.create({
      name: 'Foreign', source: 'upload', ownerOxyUserId: 'someone',
    });
    const foreignTrack = await makeTrack(foreign._id.toString(), 'Foreign Contributed');
    await attest(foreignTrack, 'a-stranger');

    const res = makeRes();
    await getMyContributions(makeReq({}, OWNER), res as unknown as Response, failNext);
    const body = res._body as { total: number };
    expect(body.total).toBe(0);
    expect(await ContributionAttestationModel.countDocuments({})).toBe(1);
  });
});

describe('takedown from the panel needs a real track', () => {
  it('404s an unknown track id', async () => {
    await makeOwnedArtist();
    const res = makeRes();
    await resolveMyContribution(
      makeReq({ trackId: new mongoose.Types.ObjectId().toString() }, OWNER, { action: 'takedown' }),
      res as unknown as Response,
      failNext,
    );
    expect(res._status).toBe(404);
    expect(await CopyrightReportModel.countDocuments({})).toBe(0);
  });
});
