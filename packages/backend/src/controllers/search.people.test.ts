import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import type { Request, Response, NextFunction } from 'express';
import { connect, clear, disconnect } from '../test/mongo';
import { PersonModel } from '../models/Person';
import { search } from './search.controller';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

interface SearchBody {
  results: { people: Array<{ name: string; img?: string }> };
  counts: { people: number; total: number };
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

describe('unified search — people category', () => {
  it('finds people by name and keeps the external img for RSS persons', async () => {
    // href-keyed (RSS) persons → no Oxy enrichment fetch (offline test).
    await PersonModel.create([
      { name: 'Joe Rogan', nameKey: 'joe rogan', href: 'https://x/jr', img: 'https://x/jr.jpg' },
      { name: 'Unrelated Person', nameKey: 'unrelated person', href: 'https://x/up' },
    ]);

    const res = makeRes();
    await search(makeReq({ q: 'rogan', category: 'people' }), res as unknown as Response, failNext);

    const body = res._body as SearchBody;
    expect(body.results.people).toHaveLength(1);
    expect(body.results.people[0].name).toBe('Joe Rogan');
    expect(body.results.people[0].img).toBe('https://x/jr.jpg');
    expect(body.counts.people).toBe(1);
    expect(body.counts.total).toBe(1);
  });
});
