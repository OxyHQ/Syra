import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { Response } from 'express';
import { connect, clear, disconnect } from '../test/mongo';
import { PodcastModel } from '../models/Podcast';
import { ArtistModel } from '../models/CatalogEntity';
import { claimPodcast } from './podcasts.controller';

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

function makeReq(podcastId: string, userId: string, linkedArtistId?: string): AuthRequest {
  return {
    params: { id: podcastId },
    body: linkedArtistId ? { linkedArtistId } : {},
    user: { id: userId },
  } as unknown as AuthRequest;
}

async function makeClaimablePodcast(source: 'rss' | 'syra' = 'syra'): Promise<string> {
  const podcast = await PodcastModel.create({
    title: 'Claimable Show',
    source,
    feedUrl: `https://feed.example/${Math.random().toString(36).slice(2)}.xml`,
    claimable: true,
  });
  return podcast._id.toString();
}

describe('claimPodcast — linkedArtistId IDOR guard', () => {
  it('rejects linking an artist the caller does not own (403)', async () => {
    const podcastId = await makeClaimablePodcast();
    const victimArtist = await ArtistModel.create({ name: 'Victim', source: 'upload', ownerOxyUserId: 'owner-B' });

    const res = makeRes();
    await claimPodcast(makeReq(podcastId, 'attacker-A', victimArtist._id.toString()), res as unknown as Response);

    expect(res._status).toBe(403);

    // The show must NOT have been claimed or linked as a side effect.
    const after = await PodcastModel.findById(podcastId).lean();
    expect(after?.claimedByOxyUserId).toBeUndefined();
    expect(after?.linkedArtistId).toBeUndefined();
    expect(after?.claimable).toBe(true);
  });

  it('allows linking an artist the caller owns (200)', async () => {
    const podcastId = await makeClaimablePodcast();
    const ownArtist = await ArtistModel.create({ name: 'Mine', source: 'upload', ownerOxyUserId: 'owner-A' });

    const res = makeRes();
    await claimPodcast(makeReq(podcastId, 'owner-A', ownArtist._id.toString()), res as unknown as Response);

    expect(res._status).toBe(200);
    const after = await PodcastModel.findById(podcastId).lean();
    expect(after?.claimedByOxyUserId).toBe('owner-A');
    expect(after?.ownerOxyUserId).toBe('owner-A');
    expect(after?.claimable).toBe(false);
    expect(after?.linkedArtistId?.toString()).toBe(ownArtist._id.toString());
  });

  it('also accepts a claim with no artist link (200)', async () => {
    const podcastId = await makeClaimablePodcast();

    const res = makeRes();
    await claimPodcast(makeReq(podcastId, 'owner-A'), res as unknown as Response);

    expect(res._status).toBe(200);
    const after = await PodcastModel.findById(podcastId).lean();
    expect(after?.claimedByOxyUserId).toBe('owner-A');
    expect(after?.linkedArtistId).toBeUndefined();
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

    const after = await PodcastModel.findById(podcastId).lean();
    expect(after?.claimedByOxyUserId).toBeUndefined();
    expect(after?.ownerOxyUserId).toBeUndefined();
    expect(after?.claimable).toBe(true);
  });

  it('refuses BEFORE the claimable check, so the source is what decides', async () => {
    // Ordering matters: were the guard placed after `claimable !== true`, an RSS
    // show would answer 409 "not claimable" and the rule would silently depend on
    // a flag nothing sets today rather than on the show's provenance.
    const podcast = await PodcastModel.create({
      title: 'Unclaimable RSS Show',
      source: 'rss',
      feedUrl: 'https://feed.example/not-claimable.xml',
      claimable: false,
    });

    const res = makeRes();
    await claimPodcast(makeReq(podcast._id.toString(), 'attacker-A'), res as unknown as Response);

    expect(res._status).toBe(403);
  });
});
