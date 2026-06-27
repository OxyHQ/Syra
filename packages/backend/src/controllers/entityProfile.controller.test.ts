import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import type { Request, Response, NextFunction } from 'express';
import { connect, clear, disconnect } from '../test/mongo';
import { ArtistModel } from '../models/Artist';
import { PersonModel } from '../models/Person';
import { PodcastModel } from '../models/Podcast';
import { EpisodeModel } from '../models/Episode';
import { TrackModel } from '../models/Track';
import { getEntityProfile } from './entityProfile.controller';
import type { EntityProfile } from '@syra/shared-types';

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

function makeReq(id: string): Request {
  return { params: { id }, query: {}, user: undefined } as unknown as Request;
}

const failNext: NextFunction = (err) => { throw err; };

async function seedPlayableTrack(artistId: string, title: string): Promise<void> {
  await TrackModel.create({
    title,
    artistName: 'X',
    artistId,
    duration: 200,
    source: 'cc',
    status: 'ready',
    isAvailable: true,
  });
}

function bodyData(res: CapturedRes): EntityProfile {
  return (res._body as { data: EntityProfile }).data;
}

describe('GET /api/p/:id — unified entity profile', () => {
  it('artist id → kind:artist with music + linked-person appearsIn', async () => {
    const artist = await ArtistModel.create({ name: 'Jane Music', source: 'cc' });
    const artistId = artist._id.toString();
    await seedPlayableTrack(artistId, 'Jane Track');
    // A Person linked to this artist drives the podcast appearances.
    await PersonModel.create({ name: 'Jane Music', linkedArtistId: artist._id });
    await PodcastModel.create({
      title: 'Jane Talks', source: 'rss', feedUrl: 'https://f/jane.xml', status: 'active',
      persons: [{ name: 'Jane Music', role: 'host' }],
    });
    await EpisodeModel.create({
      podcastId: new mongoose.Types.ObjectId(), podcastTitle: 'Jane Talks', title: 'Ep with Jane',
      guid: 'je1', pubDate: new Date(), source: 'rss', enclosureUrl: 'https://x/je1.mp3', status: 'ready',
      persons: [{ name: 'Jane Music', role: 'guest' }],
    });

    const res = makeRes();
    await getEntityProfile(makeReq(artistId), res as unknown as Response, failNext);

    expect(res._status).toBe(200);
    const data = bodyData(res);
    expect(data.kind).toBe('artist');
    expect(data.name).toBe('Jane Music');
    expect(data.music?.tracks).toHaveLength(1);
    expect(data.appearsIn?.podcasts).toHaveLength(1);
    expect(data.appearsIn?.episodes).toHaveLength(1);
  });

  it('person id → kind:person with appearsIn + linked-artist music', async () => {
    const artist = await ArtistModel.create({ name: 'Linked Band', source: 'cc' });
    const artistId = artist._id.toString();
    await seedPlayableTrack(artistId, 'Band Track');
    const person = await PersonModel.create({ name: 'Guest Joe', linkedArtistId: artist._id });
    await PodcastModel.create({
      title: 'Joe Show', source: 'rss', feedUrl: 'https://f/joe.xml', status: 'active',
      persons: [{ name: 'Guest Joe', role: 'guest' }],
    });

    const res = makeRes();
    await getEntityProfile(makeReq(person._id.toString()), res as unknown as Response, failNext);

    expect(res._status).toBe(200);
    const data = bodyData(res);
    expect(data.kind).toBe('person');
    expect(data.name).toBe('Guest Joe');
    expect(data.appearsIn?.podcasts).toHaveLength(1);
    expect(data.music?.tracks).toHaveLength(1);
    expect(data.linkedArtistId).toBe(artistId);
  });

  it('person with no linked artist → appearsIn only, no music', async () => {
    const person = await PersonModel.create({ name: 'Solo Host' });
    await PodcastModel.create({
      title: 'Solo Show', source: 'rss', feedUrl: 'https://f/solo.xml', status: 'active',
      persons: [{ name: 'Solo Host', role: 'host' }],
    });

    const res = makeRes();
    await getEntityProfile(makeReq(person._id.toString()), res as unknown as Response, failNext);

    const data = bodyData(res);
    expect(data.kind).toBe('person');
    expect(data.appearsIn?.podcasts).toHaveLength(1);
    expect(data.music).toBeUndefined();
  });

  it('unknown id → 404', async () => {
    const res = makeRes();
    await getEntityProfile(makeReq(new mongoose.Types.ObjectId().toString()), res as unknown as Response, failNext);
    expect(res._status).toBe(404);
  });

  it('invalid id → 404', async () => {
    const res = makeRes();
    await getEntityProfile(makeReq('not-an-objectid'), res as unknown as Response, failNext);
    expect(res._status).toBe(404);
  });
});
