import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import type { Request, Response, NextFunction } from 'express';
import { connect, clear, disconnect } from '../test/mongo';
import { EpisodeModel } from '../models/Episode';
import { search } from './search.controller';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

interface SearchBody {
  results: { episodes: Array<{ title: string }> };
  counts: { episodes: number; total: number };
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

function makeReq(query: Record<string, string>): Request {
  return { query } as unknown as Request;
}

const failNext: NextFunction = (err) => { throw err; };

describe('unified search — episodes category', () => {
  it('finds playable episodes by title and excludes non-ready / enclosure-less RSS', async () => {
    const podcastId = new mongoose.Types.ObjectId();
    await EpisodeModel.create([
      { podcastId, podcastTitle: 'Show', title: 'The Joe Rogan Experience #1', guid: 'g1', pubDate: new Date(), source: 'rss', enclosureUrl: 'https://x/1.mp3', status: 'ready' },
      { podcastId, podcastTitle: 'Show', title: 'Unrelated Episode', guid: 'g2', pubDate: new Date(), source: 'rss', enclosureUrl: 'https://x/2.mp3', status: 'ready' },
      { podcastId, podcastTitle: 'Show', title: 'Rogan processing', guid: 'g3', pubDate: new Date(), source: 'syra', status: 'processing' }, // excluded: not ready
      { podcastId, podcastTitle: 'Show', title: 'Rogan no enclosure', guid: 'g4', pubDate: new Date(), source: 'rss', status: 'ready' }, // excluded: rss w/o enclosure
    ]);

    const res = makeRes();
    await search(makeReq({ q: 'rogan', category: 'episodes' }), res as unknown as Response, failNext);

    const body = res._body as SearchBody;
    expect(body.results.episodes).toHaveLength(1);
    expect(body.results.episodes[0].title).toContain('Joe Rogan');
    expect(body.counts.episodes).toBe(1);
    expect(body.counts.total).toBe(1);
  });

  it('returns no episodes when nothing matches the title', async () => {
    const podcastId = new mongoose.Types.ObjectId();
    await EpisodeModel.create({ podcastId, podcastTitle: 'Show', title: 'Something else', guid: 'g1', pubDate: new Date(), source: 'rss', enclosureUrl: 'https://x/1.mp3', status: 'ready' });

    const res = makeRes();
    await search(makeReq({ q: 'rogan', category: 'episodes' }), res as unknown as Response, failNext);

    const body = res._body as SearchBody;
    expect(body.results.episodes).toHaveLength(0);
    expect(body.counts.episodes).toBe(0);
  });
});
