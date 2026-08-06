import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import type { Request, Response, NextFunction } from 'express';
import { uuidv7 } from '@oxyhq/db';
import { normalizeNameKey, type Track } from '@syra/shared-types';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import {
  catalogEntities,
  trackCredits,
  trackHlsRenditions,
  trackSources,
  tracks,
} from '../db/schema/catalog';
import { getTrackById, searchTracks } from './tracks.controller';

/**
 * `GET /api/tracks/search` and `GET /api/tracks/:id` — the two handlers whose
 * behaviour the port could change without failing anything else.
 *
 * SEARCH swapped engines twice: `new RegExp(q, 'i')` → `ilike '%q%'` →
 * `search_vector @@ websearch_to_tsquery('english', …)` with a prefix on the
 * final term, which is the ruled destination. `db/catalog/__tests__/search.test.ts`
 * owns the semantics of that change (prefix and stemming gained, infix lost);
 * what is asserted HERE is the ENDPOINT — that the handler wires the predicate
 * to the right column, still filters by playability, and cannot be made to
 * evaluate the user's string as a program.
 *
 * DETAIL changed serializer: `toApiFormat` SPREAD the Mongo document, so
 * `credits`, `sources` and the HLS ladder rode along for free. They are child
 * tables and `toTrackDto` is an allowlist, which omits in silence — so this
 * asserts all three arrive, with values.
 */
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

const failNext: NextFunction = (err) => { throw err; };

function makeReq(query: Record<string, string> = {}, params: Record<string, string> = {}): Request {
  return { query, params } as unknown as Request;
}

let artistId: string | undefined;

async function theArtist(): Promise<string> {
  if (artistId) return artistId;
  const name = `Searchable ${uuidv7()}`;
  const [row] = await getDb()
    .insert(catalogEntities)
    .values({ type: 'artist', name, nameKey: normalizeNameKey(name), source: 'upload' })
    .returning({ id: catalogEntities.id });
  if (!row) throw new Error('theArtist: insert returned no row');
  artistId = row.id;
  return artistId;
}

afterEach(() => {
  artistId = undefined;
});

async function seedTrack(
  overrides: Partial<typeof tracks.$inferInsert> = {}
): Promise<string> {
  const [track] = await getDb()
    .insert(tracks)
    .values({
      title: 'A Track',
      artistId: await theArtist(),
      artistName: 'The Band',
      duration: 180,
      source: 'upload',
      status: 'ready',
      isAvailable: true,
      ...overrides,
    })
    .returning({ id: tracks.id });
  if (!track) throw new Error('seedTrack: insert returned no row');
  return track.id;
}

async function search(q: string): Promise<{ tracks: Track[]; total: number }> {
  const res = makeRes();
  await searchTracks(makeReq({ q }), res as unknown as Response, failNext);
  expect(res._status).toBe(200);
  return res._body as { tracks: Track[]; total: number };
}

describe('GET /api/tracks/search', () => {
  it('matches a word of the title, and counts what it matched', async () => {
    await seedTrack({ title: 'Lovers Rock' });
    await seedTrack({ title: 'Something Else' });

    const body = await search('lovers');
    expect(body.tracks.map((track) => track.title)).toEqual(['Lovers Rock']);
    // `total` is a SECOND query (`countTracks`) under the same predicate, so it
    // is asserted rather than assumed: a count that lost the search condition
    // would report the whole catalogue and the page would still look right.
    expect(body.total).toBe(1);
  });

  it('matches a PREFIX, so the endpoint answers while the user is still typing', async () => {
    await seedTrack({ title: 'Lovers Rock' });
    await seedTrack({ title: 'Something Else' });

    expect((await search('lov')).tracks.map((track) => track.title)).toEqual(['Lovers Rock']);
  });

  it('matches the artist name, which shares the same stored vector', async () => {
    await seedTrack({ title: 'Untitled', artistName: 'Portishead' });
    await seedTrack({ title: 'Untitled Two', artistName: 'Someone' });

    expect((await search('portishead')).tracks.map((track) => track.title)).toEqual(['Untitled']);
  });

  /**
   * The ReDoS that was live on this endpoint — `new RegExp(req.query.q, 'i')`,
   * public, unescaped, over a collection scan — cannot exist behind a tsquery:
   * there is no backtracking engine, and `websearch_to_tsquery` never throws on
   * malformed input either.
   *
   * Asserted as BEHAVIOUR rather than as the absence of a call: the operators
   * go in as ordinary text, the query still ANSWERS, and nothing 500s. A test
   * that only checked for no exception would pass against a handler that had
   * quietly stopped matching anything.
   */
  it('takes regex and tsquery operators as text instead of evaluating them', async () => {
    await seedTrack({ title: 'aaaaaaaaaaaaaaaaaaaa' });
    await seedTrack({ title: 'Parenthetical Aside' });

    for (const hostile of ['(a+)+$', "') | 'x", '!!! & &', '\\']) {
      const body = await search(hostile);
      expect(`${hostile} → ${body.tracks.length} of ${body.total}`).toBe(`${hostile} → 0 of 0`);
    }

    // The endpoint is not simply broken: an ordinary query still answers.
    expect((await search('parenthetical')).tracks.map((t) => t.title)).toEqual([
      'Parenthetical Aside',
    ]);
  });

  it('never returns an unplayable track', async () => {
    await seedTrack({ title: 'Removed Song', copyrightRemoved: true, isAvailable: false });
    await seedTrack({ title: 'Unpublished Song', isAvailable: false });
    await seedTrack({ title: 'Available Song' });

    // Vacuity floor: the query matches all three titles, so the two absences
    // are about playability and not about the search predicate.
    const body = await search('song');
    expect(body.tracks.map((track) => track.title)).toEqual(['Available Song']);
    expect(body.total).toBe(1);
  });

  it('answers an empty query without touching the catalogue', async () => {
    await seedTrack({ title: 'Present' });

    const res = makeRes();
    await searchTracks(makeReq({ q: '   ' }), res as unknown as Response, failNext);
    expect(res._body).toEqual({ tracks: [], total: 0, hasMore: false });
  });
});

describe('GET /api/tracks/:id', () => {
  it('carries the credits, sources and HLS ladder the Mongo spread used to', async () => {
    const trackId = await seedTrack({
      title: 'Detailed',
      hlsMasterKey: 'hls/detailed/master.m3u8',
    });
    await getDb().insert(trackCredits).values([
      { trackId, position: 0, name: 'A Producer', role: 'producer', nameKey: normalizeNameKey('A Producer') },
      { trackId, position: 1, name: 'A Writer', role: 'writer', nameKey: normalizeNameKey('A Writer') },
    ]);
    await getDb().insert(trackSources).values({
      trackId,
      position: 0,
      provider: 'musicbrainz',
      externalId: 'mbid-123',
      importedAt: new Date('2026-01-01T00:00:00.000Z'),
      fields: ['title'],
    });
    await getDb().insert(trackHlsRenditions).values([
      { trackId, position: 0, manifestKey: 'hls/detailed/64/index.m3u8', bitrateKbps: 64, encrypted: true },
      { trackId, position: 1, manifestKey: 'hls/detailed/160/index.m3u8', bitrateKbps: 160, encrypted: true },
    ]);

    const res = makeRes();
    await getTrackById(makeReq({}, { id: trackId }), res as unknown as Response, failNext);

    expect(res._status).toBe(200);
    const track = res._body as Track;
    // The handler answered with the right track — otherwise every field
    // assertion below would be about the wrong object.
    expect(track.id).toBe(trackId);

    // Stored ORDER, not just presence: `position` is what preserves the Mongo
    // array's order, and a read that sorted by anything else would reorder the
    // ladder a player walks.
    expect(track.credits?.map((credit) => credit.name)).toEqual(['A Producer', 'A Writer']);
    expect(track.sources?.map((source) => source.externalId)).toEqual(['mbid-123']);
    expect(track.hls?.map((rendition) => rendition.bitrateKbps)).toEqual([64, 160]);

    // Derived from the ladder's COUNT, so a detail read that forgot to load the
    // renditions would report a preview that 404s.
    expect(track.previewAvailable).toBe(true);
  });

  it('404s an unplayable track rather than serving it', async () => {
    const trackId = await seedTrack({ title: 'Taken Down', copyrightRemoved: true });

    const res = makeRes();
    await getTrackById(makeReq({}, { id: trackId }), res as unknown as Response, failNext);

    expect(res._status).toBe(404);
  });
});
