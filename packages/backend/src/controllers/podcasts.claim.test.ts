import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { Response } from 'express';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities } from '../db/schema/catalog';
import { podcasts } from '../db/schema/podcasts';
import { findPodcastById } from '../db/podcasts/podcasts';
import { claimPodcast } from './podcasts.controller';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

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

function makeReq(podcastId: string, userId: string, linkedArtistId?: string): AuthRequest {
  return {
    params: { id: podcastId },
    body: linkedArtistId ? { linkedArtistId } : {},
    user: { id: userId },
  } as unknown as AuthRequest;
}

async function makeClaimablePodcast(source: 'rss' | 'syra' = 'syra'): Promise<string> {
  const [row] = await getDb()
    .insert(podcasts)
    .values({
      title: 'Claimable Show',
      source,
      feedUrl: `https://feed.example/${Math.random().toString(36).slice(2)}.xml`,
      claimable: true,
    })
    .returning({ id: podcasts.id });
  if (!row) throw new Error('makeClaimablePodcast: insert returned no row');
  return row.id;
}

/**
 * An ARTIST row, with `type` stated.
 *
 * Artists and persons share `catalog_entities`, and the IDOR guard under test
 * scopes its lookup to `type = 'artist'`. A fixture that omitted the column
 * would insert with `type` unset and violate the NOT NULL, but a fixture that
 * inserted a PERSON would pass every assertion below while proving nothing —
 * see the person case at the end of this file, which exists to tell the scoped
 * query from the unscoped one.
 */
async function makeArtist(
  name: string,
  ownerOxyUserId: string,
  type: 'artist' | 'person' = 'artist'
): Promise<string> {
  const [row] = await getDb()
    .insert(catalogEntities)
    .values({
      type,
      name,
      // `source` is required for an artist and forbidden-by-absence for a
      // person (`catalog_entities_source_required_for_artist_check`).
      source: type === 'artist' ? 'upload' : undefined,
      ownerOxyUserId,
    })
    .returning({ id: catalogEntities.id });
  if (!row) throw new Error('makeArtist: insert returned no row');
  return row.id;
}

describe('claimPodcast — linkedArtistId IDOR guard', () => {
  it('rejects linking an artist the caller does not own (403)', async () => {
    const podcastId = await makeClaimablePodcast();
    const victimArtist = await makeArtist('Victim', 'owner-B');

    const res = makeRes();
    await claimPodcast(makeReq(podcastId, 'attacker-A', victimArtist), res as unknown as Response);

    expect(res._status).toBe(403);

    // The show must NOT have been claimed or linked as a side effect.
    const after = await findPodcastById(podcastId);
    expect(after?.claimedByOxyUserId).toBeNull();
    expect(after?.linkedArtistId).toBeNull();
    expect(after?.claimable).toBe(true);
  });

  it('allows linking an artist the caller owns (200)', async () => {
    const podcastId = await makeClaimablePodcast();
    const ownArtist = await makeArtist('Mine', 'owner-A');

    const res = makeRes();
    await claimPodcast(makeReq(podcastId, 'owner-A', ownArtist), res as unknown as Response);

    expect(res._status).toBe(200);
    const after = await findPodcastById(podcastId);
    expect(after?.claimedByOxyUserId).toBe('owner-A');
    expect(after?.ownerOxyUserId).toBe('owner-A');
    expect(after?.claimable).toBe(false);
    expect(after?.linkedArtistId).toBe(ownArtist);
  });

  it('also accepts a claim with no artist link (200)', async () => {
    const podcastId = await makeClaimablePodcast();

    const res = makeRes();
    await claimPodcast(makeReq(podcastId, 'owner-A'), res as unknown as Response);

    expect(res._status).toBe(200);
    const after = await findPodcastById(podcastId);
    expect(after?.claimedByOxyUserId).toBe('owner-A');
    expect(after?.linkedArtistId).toBeNull();
  });

  it('rejects linking a PERSON the caller owns — the guard is scoped to artists', async () => {
    /**
     * The fixture that tells the scoped query from the unscoped one.
     *
     * Every other case here uses an artist, so a lookup that dropped
     * `type = 'artist'` would pass all of them. Persons and artists share one
     * table and a person row can carry `ownerOxyUserId` too, so without this the
     * caller could point `podcasts.linked_artist_id` at their own person row —
     * and `catalog_entities`' own discriminator CHECK says nothing about what
     * THIS column may reference.
     */
    const podcastId = await makeClaimablePodcast();
    const ownPerson = await makeArtist('Mine', 'owner-A', 'person');

    const res = makeRes();
    await claimPodcast(makeReq(podcastId, 'owner-A', ownPerson), res as unknown as Response);

    expect(res._status).toBe(403);
    const after = await findPodcastById(podcastId);
    expect(after?.linkedArtistId).toBeNull();
    expect(after?.claimable).toBe(true);
  });
});

describe('claimPodcast — RSS shows are not claimable', () => {
  it('refuses to hand over an RSS-mirrored show (403)', async () => {
    // An RSS show is somebody else's podcast that we mirrored from their feed.
    // Claiming it would transfer ownership on no evidence but arriving first.
    const podcastId = await makeClaimablePodcast('rss');

    const res = makeRes();
    await claimPodcast(makeReq(podcastId, 'attacker-A'), res as unknown as Response);

    expect(res._status).toBe(403);
    expect(res._body).toEqual({ error: 'RSS podcast claims require ownership verification' });

    const after = await findPodcastById(podcastId);
    expect(after?.claimedByOxyUserId).toBeNull();
    expect(after?.ownerOxyUserId).toBeNull();
    expect(after?.claimable).toBe(true);
  });

  it('refuses BEFORE the claimable check, so the source is what decides', async () => {
    // Ordering matters: were the guard placed after `claimable !== true`, an RSS
    // show would answer 409 "not claimable" and the rule would silently depend on
    // a flag nothing sets today rather than on the show's provenance.
    const [podcast] = await getDb()
      .insert(podcasts)
      .values({
        title: 'Unclaimable RSS Show',
        source: 'rss',
        feedUrl: 'https://feed.example/not-claimable.xml',
        claimable: false,
      })
      .returning({ id: podcasts.id });

    const res = makeRes();
    await claimPodcast(makeReq(podcast?.id ?? '', 'attacker-A'), res as unknown as Response);

    expect(res._status).toBe(403);
  });
});
