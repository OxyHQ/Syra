import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import type { Request, Response, NextFunction } from 'express';
import { uuidv7 } from '@oxyhq/db';
import { normalizeNameKey } from '@syra/shared-types';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities } from '../db/schema/catalog';
import { search } from './search.controller';

/**
 * ONE database. This file used to connect to both — persons are
 * `catalog_entities` rows, while the same handler's podcast and episode
 * categories were still Mongoose and `search` touches them on every
 * `category=all` request. Task 12 took those two categories to drizzle, so
 * every read `search` makes is Postgres and the Mongo connection is gone.
 */
beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

/** A person row — `type: 'person'`, the discriminator written out. */
async function seedPerson(values: { name: string; href?: string; img?: string }): Promise<void> {
  await getDb().insert(catalogEntities).values({
    id: uuidv7(),
    type: 'person',
    name: values.name,
    nameKey: normalizeNameKey(values.name),
    href: values.href,
    img: values.img,
  });
}

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
    await seedPerson({ name: 'Joe Rogan', href: 'https://x/jr', img: 'https://x/jr.jpg' });
    await seedPerson({ name: 'Unrelated Person', href: 'https://x/up' });

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
