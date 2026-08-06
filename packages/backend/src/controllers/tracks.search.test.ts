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
 * SEARCH swapped engines: `new RegExp(q, 'i')` became `ilike '%q%'`. Same
 * intended semantics, a different metacharacter set, and a ReDoS removed. The
 * cases below are the input shapes that make a faithful port and a careless one
 * disagree — a raw `%`, a `_`, and a regex construct that is a literal to LIKE
 * and a quantifier to a regex engine. Without them the suite would pass against
 * an unescaped pattern.
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
  it('matches a case-insensitive SUBSTRING of the title, as the regex did', async () => {
    await seedTrack({ title: 'Lovers Rock' });
    await seedTrack({ title: 'Something Else' });

    // Mid-word, lower case against a capitalised stored title: the exact pair
    // that a `websearch_to_tsquery` port would stop matching.
    const body = await search('over');
    expect(body.tracks.map((track) => track.title)).toEqual(['Lovers Rock']);
    expect(body.total).toBe(1);
  });

  it('matches the artist name as well as the title', async () => {
    await seedTrack({ title: 'Untitled', artistName: 'Portishead' });
    await seedTrack({ title: 'Untitled Two', artistName: 'Someone' });

    expect((await search('portis')).tracks.map((track) => track.title)).toEqual(['Untitled']);
  });

  /**
   * `%` is LIKE's "match anything". Unescaped, this query returns the whole
   * catalogue — the search equivalent of an open door, and the shape that
   * distinguishes an escaped pattern from a raw one. Nothing else in this file
   * can tell them apart.
   */
  it('treats a bare % as a literal, not as "everything"', async () => {
    await seedTrack({ title: 'Ordinary' });
    await seedTrack({ title: '100% Silk' });

    const body = await search('%');
    expect(body.tracks.map((track) => track.title)).toEqual(['100% Silk']);
  });

  /** `_` is LIKE's single-character wildcard — the same class as `%`. */
  it('treats _ as a literal underscore', async () => {
    await seedTrack({ title: 'abc' });
    await seedTrack({ title: 'a_c' });

    expect((await search('a_c')).tracks.map((track) => track.title)).toEqual(['a_c']);
  });

  /**
   * The ReDoS that was live on this endpoint (`new RegExp(req.query.q, 'i')`,
   * public, unescaped) cannot exist behind `ilike`: there is no backtracking
   * engine to exploit. Asserted as BEHAVIOUR — the pattern is matched literally
   * — because that is what proves the regex engine is gone, rather than that it
   * is merely escaped.
   */
  it('matches a regex construct literally instead of compiling it', async () => {
    await seedTrack({ title: 'aaaaaaaaaaaaaaaaaaaa' });
    await seedTrack({ title: 'literally (a+)+$ in the title' });

    const body = await search('(a+)+$');
    expect(body.tracks.map((track) => track.title)).toEqual(['literally (a+)+$ in the title']);
  });

  it('never returns an unplayable track', async () => {
    await seedTrack({ title: 'Taken Down', copyrightRemoved: true, isAvailable: false });
    await seedTrack({ title: 'Unpublished', isAvailable: false });

    const body = await search('n');
    expect(body.tracks).toEqual([]);
    expect(body.total).toBe(0);
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
