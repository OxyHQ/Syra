import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import type { Response, NextFunction } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { and, count, eq } from 'drizzle-orm';
import { sqlStateOf, uuidv7 } from '@oxyhq/db';
import { normalizeNameKey } from '@syra/shared-types';
import { connect, clear, disconnect } from '../test/mongo';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities, tracks } from '../db/schema/catalog';
import { copyrightReports } from '../db/schema/creators';
import { playableTrackFilter } from '../db/catalog/visibility';
import {
  reportCopyrightViolation,
  listCopyrightReports,
  resolveCopyrightReport,
} from './copyright.controller';
import { requireComplianceReviewer } from '../middleware/complianceReviewer';
import { COMPLIANCE_REVIEWERS_ENV, isComplianceReviewer } from '../services/compliance/reviewers';

/**
 * BOTH databases: the catalogue, the reports and the strike ledger are Postgres,
 * while `takeDownTrack`'s safe-harbour locker purge still reads `user_uploads`
 * and `contribution_attestations` — Task 13's tables, registered in
 * `db/catalog/hybridServices.ts`. A takedown here therefore exercises one
 * handler across two stores, which is the split as it is.
 */
beforeAll(async () => {
  await connect();
  await connectDb();
});
afterEach(async () => {
  await clear();
  await clearDb();
});
afterAll(async () => {
  await disconnect();
  await disconnectDb();
});

/** Read a track back, by id. */
async function readTrack(trackId: string) {
  const [row] = await getDb().select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
  return row;
}

/** Read an artist back, by id. */
async function readArtist(artistId: string) {
  const [row] = await getDb()
    .select()
    .from(catalogEntities)
    .where(eq(catalogEntities.id, artistId))
    .limit(1);
  return row;
}

/** Read a report back, by id. */
async function readReport(reportId: string) {
  const [row] = await getDb()
    .select()
    .from(copyrightReports)
    .where(eq(copyrightReports.id, reportId))
    .limit(1);
  return row;
}

/** How many of an artist's tracks the catalog would still list. */
async function countPlayableTracksOf(artistId: string): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(tracks)
    .where(and(playableTrackFilter(), eq(tracks.artistId, artistId)));
  return row?.total ?? 0;
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
  userId: string | undefined,
  body: unknown = {},
): AuthRequest {
  return {
    params,
    query: {},
    body,
    user: userId ? { id: userId } : undefined,
  } as unknown as AuthRequest;
}

async function makeArtist(owner = 'creator-1'): Promise<string> {
  const name = `Artist ${uuidv7()}`;
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name,
      nameKey: normalizeNameKey(name),
      source: 'upload',
      ownerOxyUserId: owner,
    })
    .returning({ id: catalogEntities.id });
  if (!artist) throw new Error('makeArtist: insert returned no row');
  return artist.id;
}

async function makeTrack(artistId: string, title = 'Song'): Promise<string> {
  const [track] = await getDb()
    .insert(tracks)
    .values({
      title, artistId, artistName: 'Creator', duration: 200, source: 'upload', status: 'ready',
    })
    .returning({ id: tracks.id });
  if (!track) throw new Error('makeTrack: insert returned no row');
  return track.id;
}

async function fileReport(trackId: string, reason = 'This is my recording'): Promise<string> {
  const res = makeRes();
  await reportCopyrightViolation(
    { body: { trackId, reason }, user: undefined } as unknown as AuthRequest,
    res as unknown as Response,
    failNext,
  );
  expect(res._status).toBe(201);
  return (res._body as { id: string }).id;
}

// ── The reviewer gate ─────────────────────────────────────────────────────────

describe('compliance reviewer allowlist', () => {
  function withReviewers<T>(value: string | undefined, run: () => T): T {
    const previous = process.env[COMPLIANCE_REVIEWERS_ENV];
    if (value === undefined) delete process.env[COMPLIANCE_REVIEWERS_ENV];
    else process.env[COMPLIANCE_REVIEWERS_ENV] = value;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env[COMPLIANCE_REVIEWERS_ENV];
      else process.env[COMPLIANCE_REVIEWERS_ENV] = previous;
    }
  }

  it('FAILS CLOSED when unconfigured — nobody is a reviewer', () => {
    withReviewers(undefined, () => {
      expect(isComplianceReviewer('anyone')).toBe(false);
    });
    withReviewers('', () => {
      expect(isComplianceReviewer('anyone')).toBe(false);
    });
  });

  it('admits exactly the configured ids, trimming whitespace', () => {
    withReviewers(' reviewer-1 , reviewer-2 ', () => {
      expect(isComplianceReviewer('reviewer-1')).toBe(true);
      expect(isComplianceReviewer('reviewer-2')).toBe(true);
      expect(isComplianceReviewer('reviewer-3')).toBe(false);
    });
  });

  it('the middleware 403s a signed-in non-reviewer and passes a reviewer through', () => {
    withReviewers('reviewer-1', () => {
      const denied = makeRes();
      let deniedCalledNext = false;
      requireComplianceReviewer(
        makeReq({}, 'ordinary-user'),
        denied as unknown as Response,
        () => { deniedCalledNext = true; },
      );
      expect(denied._status).toBe(403);
      expect(deniedCalledNext).toBe(false);

      const allowed = makeRes();
      let allowedCalledNext = false;
      requireComplianceReviewer(
        makeReq({}, 'reviewer-1'),
        allowed as unknown as Response,
        () => { allowedCalledNext = true; },
      );
      expect(allowedCalledNext).toBe(true);
      expect(allowed._status).toBe(200);
    });
  });
});

// ── Resolution ────────────────────────────────────────────────────────────────

describe('POST /api/copyright/reports/:id/resolve', () => {
  it('APPROVING removes the track from the catalog and from playback', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    const reportId = await fileReport(trackId);

    const res = makeRes();
    await resolveCopyrightReport(
      makeReq({ id: reportId }, 'reviewer-1', { status: 'approved' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(200);
    const track = await readTrack(trackId);
    expect(track?.copyrightRemoved).toBe(true);
    expect(track?.isAvailable).toBe(false);
    expect(track?.removedBy).toBe('reviewer-1');
    expect(track?.copyrightReportId).toBe(reportId);
    expect(await countPlayableTracksOf(artistId)).toBe(0);

    const report = await readReport(reportId);
    expect(report?.status).toBe('approved');
    expect(report?.resolvedBy).toBe('reviewer-1');
  });

  it('REJECTING leaves the track exactly where it was', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    const reportId = await fileReport(trackId);

    const res = makeRes();
    await resolveCopyrightReport(
      makeReq({ id: reportId }, 'reviewer-1', { status: 'rejected', resolutionNote: 'not infringing' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(200);
    const track = await readTrack(trackId);
    expect(track?.copyrightRemoved).toBe(false);
    expect(track?.isAvailable).toBe(true);

    const artist = await readArtist(artistId);
    expect(artist?.strikeCount ?? 0).toBe(0);
  });

  /**
   * The end-to-end wiring this whole change exists for: before it, a report was a
   * row nothing ever read, `strikeService` had zero callers, and the
   * repeat-infringer threshold was unreachable however many notices arrived.
   */
  it('THREE approved reports terminate the artist and take down every track', async () => {
    const artistId = await makeArtist();
    const first = await makeTrack(artistId, 'One');
    const second = await makeTrack(artistId, 'Two');
    const third = await makeTrack(artistId, 'Three');
    const untouched = await makeTrack(artistId, 'Never Reported');

    for (const trackId of [first, second, third]) {
      const reportId = await fileReport(trackId);
      const res = makeRes();
      await resolveCopyrightReport(
        makeReq({ id: reportId }, 'reviewer-1', { status: 'approved' }),
        res as unknown as Response,
        failNext,
      );
      expect(res._status).toBe(200);
    }

    const artist = await readArtist(artistId);
    expect(artist?.strikeCount).toBe(3);
    expect(artist?.terminated).toBe(true);
    expect(artist?.uploadsDisabled).toBe(true);

    // Termination is catalog-wide, including work nobody reported.
    const leftover = await readTrack(untouched);
    expect(leftover?.copyrightRemoved).toBe(true);
    expect(leftover?.isAvailable).toBe(false);
    expect(await countPlayableTracksOf(artistId)).toBe(0);
  });

  it('does not terminate before the third strike', async () => {
    const artistId = await makeArtist();
    for (const title of ['One', 'Two']) {
      const trackId = await makeTrack(artistId, title);
      const reportId = await fileReport(trackId);
      await resolveCopyrightReport(
        makeReq({ id: reportId }, 'reviewer-1', { status: 'approved' }),
        makeRes() as unknown as Response,
        failNext,
      );
    }

    const artist = await readArtist(artistId);
    expect(artist?.strikeCount).toBe(2);
    expect(artist?.terminated).toBe(false);
    expect(artist?.uploadsDisabled).toBe(false);
  });

  it('refuses to resolve the same report twice', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    const reportId = await fileReport(trackId);

    await resolveCopyrightReport(
      makeReq({ id: reportId }, 'reviewer-1', { status: 'rejected' }),
      makeRes() as unknown as Response,
      failNext,
    );

    const second = makeRes();
    await resolveCopyrightReport(
      makeReq({ id: reportId }, 'reviewer-1', { status: 'approved' }),
      second as unknown as Response,
      failNext,
    );

    expect(second._status).toBe(409);
    expect((await readTrack(trackId))?.copyrightRemoved).toBe(false);
  });

  /**
   * Was: "404s a report whose track has since been deleted, and leaves the
   * report pending" — it deleted the track out from under a pending report and
   * asserted the handler's `if (!takedown) return 404` branch.
   *
   * That premise is UNREPRESENTABLE on Postgres, and deliberately so:
   * `copyright_reports.track_id` is `.references(() => tracks.id, { onDelete:
   * 'restrict' })` because a DMCA notice is evidence that must outlive the work
   * it describes. The delete is refused with `23503`, so the state the old test
   * constructed can no longer exist.
   *
   * The RESTRICT is the stronger property and the one worth pinning, so that is
   * what this asserts instead — including that the report is still resolvable
   * afterwards, which is what "the delete changed nothing" actually means. The
   * handler's null branch stays: `takeDownTrack` returns `null` by contract and
   * `artists.controller` calls it with ids this constraint does not cover.
   */
  it('refuses to delete a reported track, and the report is still resolvable', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    const reportId = await fileReport(trackId);

    let sqlState: string | undefined;
    try {
      await getDb().delete(tracks).where(eq(tracks.id, trackId));
    } catch (error) {
      sqlState = sqlStateOf(error);
    }
    // Named in the assertion so a regression says WHICH error arrived — or that
    // the delete succeeded, which is the failure that matters.
    expect(`delete: ${sqlState ?? 'succeeded'}`).toBe('delete: 23503');
    expect((await readTrack(trackId))?.id).toBe(trackId);

    const res = makeRes();
    await resolveCopyrightReport(
      makeReq({ id: reportId }, 'reviewer-1', { status: 'approved' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(200);
    expect((await readReport(reportId))?.status).toBe('approved');
  });

  it('rejects a body that is not a decision', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    const reportId = await fileReport(trackId);

    const res = makeRes();
    await resolveCopyrightReport(
      makeReq({ id: reportId }, 'reviewer-1', { status: 'pending' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(400);
    expect((await readTrack(trackId))?.copyrightRemoved).toBe(false);
  });

  it('404s an unknown report', async () => {
    const res = makeRes();
    await resolveCopyrightReport(
      makeReq({ id: uuidv7() }, 'reviewer-1', { status: 'approved' }),
      res as unknown as Response,
      failNext,
    );
    expect(res._status).toBe(404);
  });
});

// ── The queue ─────────────────────────────────────────────────────────────────

describe('GET /api/copyright/reports', () => {
  it('returns pending reports oldest first', async () => {
    const artistId = await makeArtist();
    const first = await makeTrack(artistId, 'One');
    const second = await makeTrack(artistId, 'Two');
    const firstReport = await fileReport(first);
    const secondReport = await fileReport(second);

    const res = makeRes();
    await listCopyrightReports(makeReq({}, 'reviewer-1'), res as unknown as Response, failNext);

    const body = res._body as { reports: { id: string; status: string }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.reports.map((report) => report.id)).toEqual([firstReport, secondReport]);
    expect(body.reports.every((report) => report.status === 'pending')).toBe(true);
  });

  it('rejects a status filter that is not a status', async () => {
    const res = makeRes();
    await listCopyrightReports(
      { params: {}, query: { status: 'whatever' }, user: { id: 'reviewer-1' } } as unknown as AuthRequest,
      res as unknown as Response,
      failNext,
    );
    expect(res._status).toBe(400);
  });
});
