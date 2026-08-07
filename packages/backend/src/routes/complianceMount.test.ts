import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { normalizeNameKey } from '@syra/shared-types';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities, tracks } from '../db/schema/catalog';
import { artistClaims, copyrightReports } from '../db/schema/creators';
import { COMPLIANCE_REVIEWERS_ENV } from '../services/compliance/reviewers';
import artistsRoutes from './artists.routes';
import artistsAuthRoutes from './artists.auth.routes';
import artistClaimsRoutes from './artistClaims.routes';
import copyrightRoutes from './copyright.routes';

/**
 * Routing, not handler logic — because both bugs this suite guards against are
 * bugs of ORDER, invisible to a unit test of the handler.
 *
 * `server.ts` mounts a public router at `/api` and an authenticated one at `/api`
 * after it, so the public router matches first. That is how `/copyright` came to
 * be mounted twice with the authenticated mount unreachable, and it is why the
 * claim submission had to stay a POST under `/artists/:id` (the public artists
 * router answers only GETs) while claim REVIEW had to move off `/artists`
 * entirely (`GET /api/artists/claims` would be swallowed by `GET /:id`, which
 * 404s anything that is not an ObjectId).
 *
 * This file reproduces that mount shape and asserts each request reaches the
 * handler it is supposed to.
 */

/**
 * ONE database: the artist a claim targets, the claim itself and the copyright
 * report are all Postgres — `artist_claims` moved with Task 13. This file is
 * about ROUTE MOUNTING, so it exercises the real handlers end to end and
 * therefore needs whatever they read.
 */
beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

/** The `server.ts` mount shape: public first, authenticated second, both at /api. */
async function withApi(
  userId: string | undefined,
  exercise: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());

  const publicApiRouter = express.Router();
  // Optional auth: resolves the caller when there is one, never rejects.
  publicApiRouter.use('/artists', artistsRoutes);
  publicApiRouter.use('/copyright', (req, _res, next) => {
    if (userId) (req as AuthRequest).user = { id: userId };
    next();
  }, copyrightRoutes);

  const authenticatedApiRouter = express.Router();
  authenticatedApiRouter.use('/artists', artistsAuthRoutes);
  authenticatedApiRouter.use('/artist-claims', artistClaimsRoutes);

  app.use('/api', publicApiRouter);
  app.use('/api', (req, _res, next) => {
    if (userId) (req as AuthRequest).user = { id: userId };
    next();
  }, authenticatedApiRouter);

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });

  try {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected the test server to bind a TCP port');
    }
    await exercise(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function post(url: string, body: Record<string, unknown> = {}): Promise<globalThis.Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function withReviewers<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[COMPLIANCE_REVIEWERS_ENV];
  if (value === undefined) delete process.env[COMPLIANCE_REVIEWERS_ENV];
  else process.env[COMPLIANCE_REVIEWERS_ENV] = value;
  return run().finally(() => {
    if (previous === undefined) delete process.env[COMPLIANCE_REVIEWERS_ENV];
    else process.env[COMPLIANCE_REVIEWERS_ENV] = previous;
  });
}

async function makeClaimableArtist(): Promise<string> {
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
    })
    .returning({ id: catalogEntities.id });

  if (!artist) throw new Error('makeClaimableArtist: insert returned no row');
  return artist.id;
}

/** A ready track for `artistId`, on the Postgres side. */
async function makeTrack(artistId: string): Promise<string> {
  const [track] = await getDb()
    .insert(tracks)
    .values({
      title: 'Reported', artistId, artistName: 'X',
      duration: 100, source: 'upload', status: 'ready',
    })
    .returning({ id: tracks.id });
  if (!track) throw new Error('makeTrack: insert returned no row');
  return track.id;
}

async function readArtist(id: string) {
  const [row] = await getDb()
    .select()
    .from(catalogEntities)
    .where(eq(catalogEntities.id, id))
    .limit(1);
  return row;
}

describe('claim submission routing', () => {
  it('POST /api/artists/:id/claim reaches the claim handler past the public artists router', async () => {
    const artistId = await makeClaimableArtist();

    await withApi('claimant-1', async (baseUrl) => {
      const response = await post(`${baseUrl}/api/artists/${artistId}/claim`, {
        evidence: 'I am this artist',
      });
      expect(response.status).toBe(201);
    });

    // Reached the handler, and the handler did what it promises: a pending row,
    // and no ownership written.
    expect(
      await getDb()
        .select({ id: artistClaims.id })
        .from(artistClaims)
        .where(and(eq(artistClaims.artistId, artistId), eq(artistClaims.status, 'pending')))
    ).toHaveLength(1);
    const artist = await readArtist(artistId);
    expect(artist?.ownerOxyUserId).toBeNull();
    expect(artist?.claimable).toBe(true);
  });

  it('GET /api/artists/:id still reaches the PUBLIC handler, unauthenticated', async () => {
    const artistId = await makeClaimableArtist();
    await getDb().insert(tracks).values({
      title: 'Something Playable', artistId, artistName: 'X',
      duration: 100, source: 'upload', status: 'ready', isAvailable: true,
    });

    await withApi(undefined, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/artists/${artistId}`);
      expect(response.status).toBe(200);
    });
  });
});

describe('review routing and gating', () => {
  it('the claim queue is reviewer-gated, not merely authenticated', async () => {
    await withReviewers('reviewer-1', async () => {
      await withApi('ordinary-user', async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/artist-claims`);
        expect(response.status).toBe(403);
      });

      await withApi('reviewer-1', async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/artist-claims`);
        expect(response.status).toBe(200);
      });
    });
  });

  it('a claimant reads their own claims without being a reviewer', async () => {
    await withReviewers('reviewer-1', async () => {
      await withApi('claimant-1', async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/artist-claims/mine`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ claims: [] });
      });
    });
  });

  it('an unauthenticated caller gets 401 from the review routes, not 403', async () => {
    await withReviewers('reviewer-1', async () => {
      await withApi(undefined, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/artist-claims`);
        expect(response.status).toBe(401);
      });
    });
  });
});

describe('copyright routing', () => {
  it('reporting stays open to an unauthenticated rightsholder', async () => {
    const artistId = await makeClaimableArtist();
    const trackId = await makeTrack(artistId);

    await withApi(undefined, async (baseUrl) => {
      const response = await post(`${baseUrl}/api/copyright/report`, {
        trackId,
        reason: 'That is my recording',
      });
      expect(response.status).toBe(201);
    });

    const pending = await getDb()
      .select({ id: copyrightReports.id })
      .from(copyrightReports)
      .where(eq(copyrightReports.status, 'pending'));
    expect(pending).toHaveLength(1);
  });

  /**
   * The bug the single mount fixed: with `/copyright` on the public router only,
   * a signed-in reporter used to be recorded as anonymous because the public
   * mount matched first and carried no auth. Optional auth now resolves them.
   */
  it('records the reporter when the caller IS signed in', async () => {
    const artistId = await makeClaimableArtist();
    const trackId = await makeTrack(artistId);

    await withApi('signed-in-reporter', async (baseUrl) => {
      const response = await post(`${baseUrl}/api/copyright/report`, {
        trackId,
        reason: 'That is my recording',
      });
      expect(response.status).toBe(201);
    });

    const [report] = await getDb().select().from(copyrightReports).limit(1);
    expect(report?.reporterOxyUserId).toBe('signed-in-reporter');
  });

  it('the report queue and resolution are reviewer-gated on the same mount', async () => {
    await withReviewers('reviewer-1', async () => {
      await withApi('ordinary-user', async (baseUrl) => {
        expect((await fetch(`${baseUrl}/api/copyright/reports`)).status).toBe(403);
        expect(
          (await post(`${baseUrl}/api/copyright/reports/000000000000000000000000/resolve`, {
            status: 'approved',
          })).status,
        ).toBe(403);
      });

      await withApi('reviewer-1', async (baseUrl) => {
        expect((await fetch(`${baseUrl}/api/copyright/reports`)).status).toBe(200);
      });
    });
  });

  it('FAILS CLOSED for everyone when no reviewers are configured', async () => {
    await withReviewers(undefined, async () => {
      await withApi('anyone-at-all', async (baseUrl) => {
        expect((await fetch(`${baseUrl}/api/copyright/reports`)).status).toBe(403);
        expect((await fetch(`${baseUrl}/api/artist-claims`)).status).toBe(403);
      });
    });
  });
});
