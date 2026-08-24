import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { uuidv7 } from '@oxyhq/db';
import type { Request, Response, NextFunction } from 'express';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { episodes, podcasts } from '../db/schema/podcasts';
import { search } from './search.controller';

/**
 * One database now: Task 12 took the episodes category to `episodes.search_vector`,
 * so this file no longer straddles two stores.
 *
 * The match is a tsquery rather than a case-insensitive regex, which changes what
 * "finds by title" means: whole lexemes plus a prefix on the final term, with
 * stemming, and no infix. The fixtures below are chosen so every one of them is a
 * whole word — `rogan` matches `Rogan` as a lexeme, which the regex also did — so
 * these assertions test the playability gate, not the tokenizer. The tokenizer's
 * own edges are `db/catalog/__tests__/search.test.ts`.
 */
beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

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

/**
 * A show for the episodes to belong to.
 *
 * `episodes.podcast_id` is a real foreign key, so a bare id no longer works —
 * and the show's own `status` is now part of the episode gate (an episode of an
 * unpublished show drops out of search with it), which is why every fixture show
 * here is explicitly `active`.
 */
async function makeShow(
  status: 'active' | 'unavailable' = 'active',
  visibility: 'private' | 'unlisted' | 'public' = 'public'
): Promise<string> {
  const id = uuidv7();
  await getDb().insert(podcasts).values({ id, title: 'Show', source: 'rss', status, visibility });
  return id;
}

describe('unified search — episodes category', () => {
  it('finds playable episodes by title and excludes non-ready / enclosure-less RSS', async () => {
    const podcastId = await makeShow();
    await getDb().insert(episodes).values([
      { podcastId, podcastTitle: 'Show', title: 'The Joe Rogan Experience #1', guid: 'g1', pubDate: new Date(), source: 'rss', enclosureUrl: 'https://x/1.mp3', status: 'ready' },
      { podcastId, podcastTitle: 'Show', title: 'Unrelated Episode', guid: 'g2', pubDate: new Date(), source: 'rss', enclosureUrl: 'https://x/2.mp3', status: 'ready' },
      { podcastId, podcastTitle: 'Show', title: 'Rogan processing', guid: 'g3', pubDate: new Date(), source: 'syra', status: 'processing' }, // excluded: not ready
      { podcastId, podcastTitle: 'Show', title: 'Rogan no enclosure', guid: 'g4', pubDate: new Date(), source: 'rss', status: 'ready' }, // excluded: rss w/o enclosure
      // Excluded: RSS with an EMPTY enclosure, not an absent one. Mongo needed
      // three conditions (`$exists`, not null, not '') for this; Postgres needs
      // two, and without a fixture on this side of it `is not null` alone would
      // pass every other case in this block.
      { podcastId, podcastTitle: 'Show', title: 'Rogan blank enclosure', guid: 'g5', pubDate: new Date(), source: 'rss', enclosureUrl: '', status: 'ready' },
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
    const podcastId = await makeShow();
    await getDb().insert(episodes).values({ podcastId, podcastTitle: 'Show', title: 'Something else', guid: 'g1', pubDate: new Date(), source: 'rss', enclosureUrl: 'https://x/1.mp3', status: 'ready' });

    const res = makeRes();
    await search(makeReq({ q: 'rogan', category: 'episodes' }), res as unknown as Response, failNext);

    const body = res._body as SearchBody;
    expect(body.results.episodes).toHaveLength(0);
    expect(body.counts.episodes).toBe(0);
  });

  it('drops a playable episode whose SHOW was unpublished', async () => {
    /**
     * The hidden-show rule, which used to be a separate `find({ status: { $ne:
     * 'active' } })` feeding a `$nin` and is a correlated semi-join now
     * (`showIsActive`). Both fixtures are `status: 'ready'` RSS episodes WITH an
     * enclosure, so the only thing that can separate them is their show — which
     * is what makes this able to fail if the semi-join were dropped.
     */
    const activeShow = await makeShow('active');
    const hiddenShow = await makeShow('unavailable');
    await getDb().insert(episodes).values([
      { podcastId: activeShow, podcastTitle: 'Show', title: 'Rogan on air', guid: 'h1', pubDate: new Date(), source: 'rss', enclosureUrl: 'https://x/1.mp3', status: 'ready' },
      { podcastId: hiddenShow, podcastTitle: 'Show', title: 'Rogan pulled', guid: 'h2', pubDate: new Date(), source: 'rss', enclosureUrl: 'https://x/2.mp3', status: 'ready' },
    ]);

    const res = makeRes();
    await search(makeReq({ q: 'rogan', category: 'episodes' }), res as unknown as Response, failNext);

    const body = res._body as SearchBody;
    expect(body.results.episodes.map((episode) => episode.title)).toEqual(['Rogan on air']);
    expect(body.counts.episodes).toBe(1);
  });

  it('drops an episode whose show is private OR unlisted, and keeps the public one', async () => {
    /**
     * The visibility axis, beside the `status` one above. Search is a DISCOVERY
     * surface, so the gate is LISTABLE — active AND public — which means
     * `unlisted` is excluded here even though it is reachable by a direct link.
     * That is the whole difference between `unlisted` and `public`, and a test
     * covering only `private` would pass against a gate that let unlisted
     * through.
     *
     * All three fixtures are `status: 'active'`, `ready`, RSS episodes WITH an
     * enclosure, so nothing but their show's visibility can separate them.
     */
    const publicShow = await makeShow('active', 'public');
    const unlistedShow = await makeShow('active', 'unlisted');
    const privateShow = await makeShow('active', 'private');
    await getDb().insert(episodes).values([
      { podcastId: publicShow, podcastTitle: 'Show', title: 'Rogan in public', guid: 'v1', pubDate: new Date(), source: 'rss', enclosureUrl: 'https://x/1.mp3', status: 'ready' },
      { podcastId: unlistedShow, podcastTitle: 'Show', title: 'Rogan unlisted', guid: 'v2', pubDate: new Date(), source: 'rss', enclosureUrl: 'https://x/2.mp3', status: 'ready' },
      { podcastId: privateShow, podcastTitle: 'Show', title: 'Rogan private', guid: 'v3', pubDate: new Date(), source: 'rss', enclosureUrl: 'https://x/3.mp3', status: 'ready' },
    ]);

    const res = makeRes();
    await search(makeReq({ q: 'rogan', category: 'episodes' }), res as unknown as Response, failNext);

    const body = res._body as SearchBody;
    expect(body.results.episodes.map((episode) => episode.title)).toEqual(['Rogan in public']);
    expect(body.counts.episodes).toBe(1);
  });
});
