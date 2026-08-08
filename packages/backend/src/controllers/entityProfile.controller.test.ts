import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { uuidv7 } from '@oxyhq/db';
import type { Request, Response, NextFunction } from 'express';
import { normalizeNameKey } from '@syra/shared-types';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities, tracks } from '../db/schema/catalog';
import { episodePersons, episodes, podcastPersons, podcasts } from '../db/schema/podcasts';
import { getEntityProfile } from './entityProfile.controller';
import type { EntityProfile } from '@syra/shared-types';

/**
 * POSTGRES ONLY.
 *
 * This block used to say the opposite, and the reason it was wrong is worth
 * keeping: nothing here reads a Mongoose model, but `entityProfile.controller`
 * still GATED every handler on `isDatabaseConnected()` — Mongoose readiness —
 * so without a Mongo connection every request answered 503 and these suites had
 * to open one. The guard was the whole dependency.
 *
 * Task 15 switched that gate to `isPostgresConnected()`, and the Mongo hooks
 * went with it. `db/__tests__/connectivityGates.test.ts` used to keep this true
 * by walking this controller's whole import graph and failing if anything it
 * reached opened a model; it was retired in 8cd87a8 together with its subject.
 * Nothing polices it now because nothing can violate it — `mongoose` is not a
 * dependency and `src/models/` does not exist, so reintroducing a model is a
 * package install and a new directory, not a silent import.
 */
beforeAll(async () => {
  await connectDb();
});
afterEach(async () => {
  await clearDb();
});
afterAll(async () => {
  await disconnectDb();
});

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
  await getDb().insert(tracks).values({
    title,
    artistName: 'X',
    artistId,
    duration: 200,
    source: 'cc',
    status: 'ready',
    isAvailable: true,
  });
}

/** An artist row; returns its id. */
async function makeArtist(
  name: string,
  overrides: Partial<typeof catalogEntities.$inferInsert> = {}
): Promise<string> {
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist', name, nameKey: normalizeNameKey(name), source: 'cc', ...overrides,
    })
    .returning({ id: catalogEntities.id });

  if (!artist) throw new Error('makeArtist: insert returned no row');
  return artist.id;
}

/** A person row, optionally linked to an artist; returns its id. */
async function makePerson(name: string, linkedArtistId?: string): Promise<string> {
  const [person] = await getDb()
    .insert(catalogEntities)
    .values({ type: 'person', name, ...(linkedArtistId ? { linkedArtistId } : {}) })
    .returning({ id: catalogEntities.id });

  if (!person) throw new Error('makePerson: insert returned no row');
  return person.id;
}

/**
 * A show crediting one person by NAME.
 *
 * The credits are `podcast_persons` rows now, not an embedded array, so a
 * fixture has to create the child row explicitly — and `position` is required,
 * because that column is what preserves the order the Mongo array had.
 */
async function makeShowCrediting(title: string, feedUrl: string, personName: string): Promise<string> {
  const id = uuidv7();
  await getDb().insert(podcasts).values({ id, title, source: 'rss', feedUrl, status: 'active' });
  await getDb()
    .insert(podcastPersons)
    .values({ podcastId: id, position: 0, name: personName, role: 'host' });
  return id;
}

/** An episode on `podcastId`, crediting one person by name. */
async function makeEpisodeCrediting(
  podcastId: string,
  podcastTitle: string,
  title: string,
  personName: string
): Promise<string> {
  const id = uuidv7();
  await getDb().insert(episodes).values({
    id,
    podcastId,
    podcastTitle,
    title,
    guid: id,
    pubDate: new Date(),
    source: 'rss',
    enclosureUrl: `https://x/${id}.mp3`,
    status: 'ready',
  });
  await getDb()
    .insert(episodePersons)
    .values({ episodeId: id, position: 0, name: personName, role: 'guest' });
  return id;
}

function bodyData(res: CapturedRes): EntityProfile {
  return (res._body as { data: EntityProfile }).data;
}

describe('GET /api/p/:id — unified entity profile', () => {
  it('artist id → kind:artist with music + linked-person appearsIn', async () => {
    const artistId = await makeArtist('Jane Music', {
      genres: ['rock', 'indie'], primaryColor: '#111', secondaryColor: '#222', verified: true,
      // The embedded `stats` subdocument is flat columns now.
      statsFollowers: 123, statsMonthlyListeners: 456,
    });
    await seedPlayableTrack(artistId, 'Jane Track');
    // A Person linked to this artist drives the podcast appearances.
    await makePerson('Jane Music', artistId);
    const showId = await makeShowCrediting('Jane Talks', 'https://f/jane.xml', 'Jane Music');
    await makeEpisodeCrediting(showId, 'Jane Talks', 'Ep with Jane', 'Jane Music');

    const res = makeRes();
    await getEntityProfile(makeReq(artistId), res as unknown as Response, failNext);

    expect(res._status).toBe(200);
    const data = bodyData(res);
    expect(data.kind).toBe('artist');
    expect(data.name).toBe('Jane Music');
    expect(data.genres).toEqual(['rock', 'indie']);
    expect(data.primaryColor).toBe('#111');
    expect(data.secondaryColor).toBe('#222');
    expect(data.verified).toBe(true);
    expect(data.stats?.followers).toBe(123);
    expect(data.stats?.monthlyListeners).toBe(456);
    expect(data.music?.tracks).toHaveLength(1);
    expect(data.appearsIn?.podcasts).toHaveLength(1);
    expect(data.appearsIn?.episodes).toHaveLength(1);
  });

  it('person id → kind:person with appearsIn + linked-artist music', async () => {
    const artistId = await makeArtist('Linked Band');
    await seedPlayableTrack(artistId, 'Band Track');
    const personId = await makePerson('Guest Joe', artistId);
    await makeShowCrediting('Joe Show', 'https://f/joe.xml', 'Guest Joe');

    const res = makeRes();
    await getEntityProfile(makeReq(personId), res as unknown as Response, failNext);

    expect(res._status).toBe(200);
    const data = bodyData(res);
    expect(data.kind).toBe('person');
    expect(data.name).toBe('Guest Joe');
    expect(data.appearsIn?.podcasts).toHaveLength(1);
    expect(data.music?.tracks).toHaveLength(1);
    expect(data.linkedArtistId).toBe(artistId);
  });

  it('person with no linked artist → appearsIn only, no music', async () => {
    const personId = await makePerson('Solo Host');
    await makeShowCrediting('Solo Show', 'https://f/solo.xml', 'Solo Host');

    const res = makeRes();
    await getEntityProfile(makeReq(personId), res as unknown as Response, failNext);

    const data = bodyData(res);
    expect(data.kind).toBe('person');
    expect(data.appearsIn?.podcasts).toHaveLength(1);
    expect(data.music).toBeUndefined();
  });

  it('an episode of an UNPUBLISHED show drops out of appearsIn', async () => {
    /**
     * The show-visibility rule inside the `appearsIn` shelf.
     *
     * Both episodes are `status: 'ready'` RSS episodes with an enclosure, and
     * both credit the same person, so the only thing separating them is their
     * SHOW's status — which is what `publiclyPlayableEpisodeFilter`'s semi-join
     * decides. Without a fixture on the hidden side, dropping that half of the
     * predicate would pass every other case in this file.
     */
    const personId = await makePerson('Shelf Host');
    const active = await makeShowCrediting('Live Show', 'https://f/live.xml', 'Shelf Host');
    await makeEpisodeCrediting(active, 'Live Show', 'Still listed', 'Shelf Host');

    const hidden = uuidv7();
    await getDb().insert(podcasts).values({
      id: hidden, title: 'Pulled Show', source: 'rss', feedUrl: 'https://f/pulled.xml',
      status: 'unavailable',
    });
    // The hidden show has to CREDIT the person too, or its absence from the
    // `podcasts` half below would prove nothing about the show filter.
    await getDb()
      .insert(podcastPersons)
      .values({ podcastId: hidden, position: 0, name: 'Shelf Host', role: 'host' });
    await makeEpisodeCrediting(hidden, 'Pulled Show', 'Hidden with its show', 'Shelf Host');

    const res = makeRes();
    await getEntityProfile(makeReq(personId), res as unknown as Response, failNext);

    const data = bodyData(res);
    expect(data.appearsIn?.episodes?.map((episode) => episode.title)).toEqual(['Still listed']);
    // The SHOW itself is still listed — `status <> 'removed'` for shows, not
    // `= 'active'`, so unpublishing hides a show's episodes from other people's
    // profiles without erasing the credit itself.
    expect(data.appearsIn?.podcasts?.map((show) => show.title).sort()).toEqual([
      'Live Show',
      'Pulled Show',
    ]);
  });

  it('unknown id → 404', async () => {
    const res = makeRes();
    // A uuid v7, the shape `generatedId()` mints — an ObjectId hex here would
    // 404 for the right reason while proving nothing about the id space every
    // new entity is actually written in.
    await getEntityProfile(makeReq(uuidv7()), res as unknown as Response, failNext);
    expect(res._status).toBe(404);
  });

  it('invalid id → 404', async () => {
    const res = makeRes();
    await getEntityProfile(makeReq('not-an-id-in-either-shape'), res as unknown as Response, failNext);
    expect(res._status).toBe(404);
  });
});
