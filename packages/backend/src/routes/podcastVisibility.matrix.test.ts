/**
 * The podcast visibility matrix: TWO shows x THREE viewers x every read surface.
 *
 * ## Why a matrix and not a test per hole
 *
 * `podcasts.visibility` is enforced in fifteen different places — three show
 * handlers, five media endpoints, episode detail, the resume list, three
 * discovery surfaces and two write endpoints that used to answer differently for
 * "private" and "nonexistent". A test per hole proves each fix in isolation and
 * proves nothing about the SET, which is where this class of bug actually lives:
 * one surface reading the show and the next one not. Enumerating the surfaces in
 * one table is what makes a missing row visible as a missing row.
 *
 * ## The two things that make it a measurement
 *
 * **A positive control on every row.** Each surface is exercised against the
 * PUBLIC show with the same viewer, and must answer 200 (or list the show). Without
 * it, "the private show 404s" is indistinguishable from "this request 404s for
 * some unrelated reason" — a bad path, a missing fixture, an id typo — and a
 * suite made of nothing but 404 assertions passes beautifully against a server
 * that is simply broken.
 *
 * **A vacuity floor.** The suite is written so it can be run against the source
 * as it was BEFORE the visibility model existed, and it FAILS there. That is why
 * {@link setVisibility} writes the column with raw SQL rather than through
 * drizzle: the pre-change schema does not declare `visibility`, so a typed
 * insert would not compile against it and the floor could not be run at all.
 * The migration has already added the column, so the raw write is honest — it
 * sets a real column to a real value; only the ORM's knowledge of it is
 * bypassed.
 *
 * ## What the anonymous HLS rows mean
 *
 * `/stream`, `/key`, `/master.m3u8` and `/v/:variant` answer 401 to an anonymous
 * caller on a PUBLIC show, and that is pre-existing, correct behaviour rather
 * than a visibility rule: HLS requires either a bearer session or a `?t=` stream
 * token, and always has. On the PRIVATE show the same anonymous caller gets 404,
 * not 401 — the audience gate runs before the credential check precisely so the
 * two cannot be told apart from outside. The discriminating comparison is the
 * STRANGER row: 200 on the public show, 404 on the private one, which is exactly
 * the pair that would have been 200/200 before this change.
 *
 * `/audio` is the opposite and deliberately so: it is the `<enclosure>` URL
 * every podcast client fetches with no credentials at all, so it answers 200 to
 * an anonymous caller and only `private` makes it ask who is calling.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { Readable } from 'stream';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities } from '../db/schema/catalog';
import {
  episodeHlsRenditions,
  episodePersons,
  episodes as episodesTable,
  podcastPersons,
  podcasts,
} from '../db/schema/podcasts';
import { trackKeys } from '../db/schema/trackKeys';
import { getS3HlsKey, getS3PodcastEpisodeAudioKey } from '../config/s3.config';
import { mintStreamToken } from '../services/stream/streamToken';
import * as realS3 from '../services/s3Service';
import podcastsRoutes from './podcasts.routes';
import episodesRoutes from './episodes.routes';
import searchRoutes from './search';
import entityProfileRoutes from './entityProfile.routes';

process.env.STREAM_TOKEN_SECRET = 'test-secret-podcast-visibility-matrix';

// ── S3, faked for THIS SUITE'S KEYS ONLY ──────────────────────────────────────

/**
 * The object keys this suite seeded, and what each one contains.
 *
 * `mock.module` is process-global — it is not scoped to this file — so a blanket
 * fake would hand every later test in the run a working S3 that answers for any
 * key, silently changing suites that assert on a MISSING object. Every fake
 * below therefore answers only for a key belonging to a show THIS suite seeded
 * and DELEGATES to the real function for anything else, so nothing outside this
 * file behaves differently than it did before this suite existed.
 *
 * Two structures, because two questions are asked. `fakeObjects` holds the
 * bodies of the objects that are READ back (the source audio, the rendition
 * manifest). `fakePrefixes` holds the key prefixes this suite owns, because
 * segment presigning asks about keys the fixture never wrote — the variant
 * rewriter presigns `<manifest dir>/segment-0.ts`, which exists only inside the
 * manifest text.
 */
const fakeObjects = new Map<string, string>();
const fakePrefixes = new Set<string>();

/**
 * The real S3 functions, captured BY VALUE before the mock below.
 *
 * `import * as realS3` is a LIVE binding, so once `mock.module` replaces the
 * module, `realS3.getObjectMetadata` IS the fake and the delegation branch below
 * re-enters itself. It was latent here — no later suite reached these functions
 * with a non-suite key — and it was NOT latent in the ingest task's suites, where
 * it recursed until the stack overflowed. Fixed in both places the same way.
 */
const realGetObjectMetadata = realS3.getObjectMetadata;
const realStreamFromS3 = realS3.streamFromS3;
const realGetPresignedUrl = realS3.getPresignedUrl;

/** A byte length the range parser and `Content-Length` can both work with. */
const AUDIO_BYTES = 'audio-bytes-for-the-visibility-matrix';

function isSuiteKey(key: string): boolean {
  if (fakeObjects.has(key)) return true;
  for (const prefix of fakePrefixes) if (key.startsWith(prefix)) return true;
  return false;
}

mock.module('../services/s3Service', () => ({
  ...realS3,
  getObjectMetadata: async (key: string) => {
    const body = fakeObjects.get(key);
    if (body === undefined) return realGetObjectMetadata(key);
    return { contentLength: Buffer.byteLength(body), contentType: 'audio/mpeg' };
  },
  streamFromS3: async (key: string, options?: { start: number; end: number }) => {
    const body = fakeObjects.get(key);
    if (body === undefined) return realStreamFromS3(key, options);
    const buffer = Buffer.from(body);
    const slice = options ? buffer.subarray(options.start, options.end + 1) : buffer;
    return { stream: Readable.from([slice]) };
  },
  getPresignedUrl: async (key: string, ttlSec?: number) => {
    if (!isSuiteKey(key)) return realGetPresignedUrl(key, ttlSec);
    return `https://s3.example.invalid/${key}?signed=1`;
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OWNER = 'oxy-visibility-owner';
const STRANGER = 'oxy-visibility-stranger';

/**
 * A rare token planted in every fixture title, so the search assertions match
 * this suite's own rows and nothing else. `clearDb` runs between tests, but a
 * search term that also matched a stop word or a common word would make "the
 * private show is absent" true for the wrong reason.
 */
const RARE_TERM = 'zebracorn';

/** The credit identity both shows share, so ONE person page lists both. */
const CREDIT_HREF = 'https://people.example.invalid/zebracorn-host';

interface ShowFixture {
  readonly showId: string;
  readonly episodeId: string;
  readonly bitrateKbps: number;
}

/**
 * Write `visibility` with raw SQL — see this file's doc comment.
 *
 * The column exists in the database (migration `0027`); what this bypasses is
 * the drizzle SCHEMA's knowledge of it, which is what lets this suite run
 * unchanged against the pre-change source as its own vacuity floor.
 */
async function setVisibility(showId: string, visibility: string): Promise<void> {
  await getDb().execute(
    sql`update podcasts set visibility = ${visibility} where id = ${showId}`
  );
}

/**
 * One complete show: the row, one ready episode, an HLS ladder, an AES key and a
 * credit on both the show and the episode.
 *
 * Every surface in the matrix needs a different part of this, and they have to
 * be the SAME show — a fixture per surface would let the public and private
 * shows differ in something other than their visibility.
 */
async function seedShow(visibility: string): Promise<ShowFixture> {
  const showId = uuidv7();
  const episodeId = uuidv7();
  const bitrateKbps = 96;

  await getDb().insert(podcasts).values({
    id: showId,
    title: `${RARE_TERM} Show (${visibility})`,
    author: 'A Host',
    source: 'syra',
    status: 'active',
    ownerOxyUserId: OWNER,
    claimable: false,
    feedUrl: `https://feeds.example.invalid/${showId}.xml`,
  });
  await setVisibility(showId, visibility);

  // The real key builders, not a guess: `getS3HlsKey(podcastId, episodeId, rel)`
  // and `getS3PodcastEpisodeAudioKey(episodeId, podcastId, format)` are what the
  // handlers ask S3 for, so a fixture that invented its own layout would make
  // the fake answer for a key nothing requests and the real client answer for
  // the one that is.
  const manifestKey = getS3HlsKey(showId, episodeId, `${bitrateKbps}/index.m3u8`);
  const audioKey = getS3PodcastEpisodeAudioKey(episodeId, showId, 'mp3');

  await getDb().insert(episodesTable).values({
    id: episodeId,
    podcastId: showId,
    podcastTitle: `${RARE_TERM} Show`,
    title: `${RARE_TERM} Episode`,
    guid: `guid-${episodeId}`,
    pubDate: new Date('2026-01-01T00:00:00.000Z'),
    source: 'syra',
    status: 'ready',
    duration: 60,
    audioSourceUrl: `/api/podcasts/episodes/${episodeId}/audio`,
    audioSourceFormat: 'mp3',
    hlsMasterKey: `hls/${showId}/${episodeId}/master.m3u8`,
  });

  await getDb().insert(episodeHlsRenditions).values({
    episodeId,
    position: 0,
    manifestKey,
    bitrateKbps,
    encrypted: true,
  });

  await getDb()
    .insert(trackKeys)
    .values({ episodeId, keyHex: 'deadbeefdeadbeefdeadbeefdeadbeef', keyUri: 'key' });

  // Credits carry `href` and NOT `linkedOxyUserId` on purpose: the credit-match
  // tier order is `linkedOxyUserId` -> `href` -> name, and the Oxy tier would
  // send `enrichPersons` to the network for every `/api/p/:id` assertion below.
  await getDb()
    .insert(podcastPersons)
    .values({ podcastId: showId, position: 0, name: 'A Host', href: CREDIT_HREF });
  await getDb()
    .insert(episodePersons)
    .values({ episodeId, position: 0, name: 'A Host', href: CREDIT_HREF });

  fakePrefixes.add(getS3HlsKey(showId, episodeId, ''));
  fakeObjects.set(audioKey, AUDIO_BYTES);
  fakeObjects.set(
    manifestKey,
    ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="placeholder"', '#EXTINF:6.0,', 'segment-0.ts', '#EXT-X-ENDLIST'].join('\n')
  );

  return { showId, episodeId, bitrateKbps };
}

/** The person page both shows appear on. */
async function seedPerson(): Promise<string> {
  const [row] = await getDb()
    .insert(catalogEntities)
    .values({ type: 'person', name: 'A Host', href: CREDIT_HREF })
    .returning({ id: catalogEntities.id });
  if (!row) throw new Error('seedPerson: insert returned no row');
  return row.id;
}

// ── The server, with a per-REQUEST viewer ─────────────────────────────────────

/**
 * The viewer travels in a header rather than in a module-level variable.
 *
 * One server serves all three viewers, and a mutable "current viewer" would make
 * every assertion depend on assignment order — the shape that passes locally and
 * interleaves in CI. A header is request-scoped by construction.
 */
const VIEWER_HEADER = 'x-test-viewer';

let server: Server;
let baseUrl: string;
let bulkImportWas: string | undefined;

beforeAll(async () => {
  await connectDb();

  /**
   * `GET /api/podcasts/search` awaits `syncPodcastSearch`, which calls the
   * PodcastIndex/Apple directories over the network before reading the database.
   * Left on, this suite reaches the public internet — measured: it imported a
   * real feed from anchor.fm — which is slow, flaky in CI and rude to a service
   * that owes us nothing. The env kill-switch turns it off without a
   * `mock.module`, and it is RESTORED in `afterAll` because `process.env` is
   * process-global exactly as a module mock is.
   */
  bulkImportWas = process.env.PODCAST_BULK_IMPORT_ENABLED;
  process.env.PODCAST_BULK_IMPORT_ENABLED = 'false';

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const viewer = req.headers[VIEWER_HEADER];
    if (typeof viewer === 'string' && viewer.length > 0) {
      (req as AuthRequest).user = { id: viewer };
    }
    next();
  });
  app.use('/api/podcasts', podcastsRoutes);
  app.use('/api/episodes', episodesRoutes);
  app.use('/api/search', searchRoutes);
  app.use('/api/p', entityProfileRoutes);

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await clearDb();
  fakeObjects.clear();
  fakePrefixes.clear();
});

afterAll(async () => {
  if (bulkImportWas === undefined) delete process.env.PODCAST_BULK_IMPORT_ENABLED;
  else process.env.PODCAST_BULK_IMPORT_ENABLED = bulkImportWas;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectDb();
});

/** The three viewers every surface is crossed with. `null` is anonymous. */
const VIEWERS = {
  anonymous: null,
  stranger: STRANGER,
  owner: OWNER,
} as const;

type ViewerName = keyof typeof VIEWERS;

function headersFor(viewer: ViewerName): Record<string, string> {
  const id = VIEWERS[viewer];
  return id === null ? {} : { [VIEWER_HEADER]: id };
}

async function get(path: string, viewer: ViewerName): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: headersFor(viewer) });
}

async function post(path: string, viewer: ViewerName): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: headersFor(viewer) });
}

async function put(path: string, viewer: ViewerName, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { ...headersFor(viewer), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Both shows, always seeded together.
 *
 * The public one is not decoration: it is the positive control for every
 * assertion in this file, and the reason a run that returns 404 for everything
 * cannot pass.
 */
async function seedBoth(): Promise<{ pub: ShowFixture; priv: ShowFixture }> {
  return { pub: await seedShow('public'), priv: await seedShow('private') };
}

// ── The matrix ────────────────────────────────────────────────────────────────

/**
 * Each entry builds the request path for a show and states what each viewer must
 * get, for the public show and for the private one.
 *
 * Written as DATA rather than as one `it` per surface, so a surface that nobody
 * added is a missing line in a visible table rather than a test that silently
 * does not exist.
 */
interface Surface {
  readonly name: string;
  readonly request: (fixture: ShowFixture, viewer: ViewerName) => Promise<Response>;
  /** Status for the PUBLIC show, per viewer. */
  readonly onPublic: Record<ViewerName, number>;
  /** Status for the PRIVATE show, per viewer. */
  readonly onPrivate: Record<ViewerName, number>;
}

const ALL_VIEWERS: readonly ViewerName[] = ['anonymous', 'stranger', 'owner'];

/** Every viewer sees it; the owner is not special. */
const OPEN = { anonymous: 200, stranger: 200, owner: 200 } as const;
/** Gone for everyone but the owner, and "gone" is 404 — never 403. */
const OWNER_ONLY = { anonymous: 404, stranger: 404, owner: 200 } as const;
/** HLS: a session or a `?t=` token is required, so anonymous is 401 on a show it may see. */
const SESSION_REQUIRED = { anonymous: 401, stranger: 200, owner: 200 } as const;
/**
 * And 404 on one it may not — the audience gate runs FIRST, so "hidden" never
 * degrades into the 401 that would confirm the id exists.
 */
const SESSION_REQUIRED_OWNER_ONLY = { anonymous: 404, stranger: 404, owner: 200 } as const;
/** A write endpoint behind `requireAuth`: anonymous never reaches the handler. */
const AUTH_REQUIRED = { anonymous: 401, stranger: 200, owner: 200 } as const;
const AUTH_REQUIRED_OWNER_ONLY = { anonymous: 401, stranger: 404, owner: 200 } as const;

const SURFACES: readonly Surface[] = [
  {
    name: 'GET /api/podcasts/:id',
    request: (f, v) => get(`/api/podcasts/${f.showId}`, v),
    onPublic: OPEN,
    onPrivate: OWNER_ONLY,
  },
  {
    name: 'GET /api/podcasts/:id/episodes',
    request: (f, v) => get(`/api/podcasts/${f.showId}/episodes`, v),
    onPublic: OPEN,
    onPrivate: OWNER_ONLY,
  },
  {
    name: 'GET /api/podcasts/:id/rss',
    request: (f, v) => get(`/api/podcasts/${f.showId}/rss`, v),
    onPublic: OPEN,
    onPrivate: OWNER_ONLY,
  },
  {
    name: 'GET /api/episodes/:id',
    request: (f, v) => get(`/api/episodes/${f.episodeId}`, v),
    onPublic: OPEN,
    onPrivate: OWNER_ONLY,
  },
  {
    name: 'GET /api/podcasts/episodes/:id/audio',
    request: (f, v) => get(`/api/podcasts/episodes/${f.episodeId}/audio`, v),
    onPublic: OPEN,
    onPrivate: OWNER_ONLY,
  },
  {
    name: 'GET /api/podcasts/episodes/:id/stream',
    request: (f, v) => get(`/api/podcasts/episodes/${f.episodeId}/stream`, v),
    onPublic: SESSION_REQUIRED,
    onPrivate: SESSION_REQUIRED_OWNER_ONLY,
  },
  {
    name: 'GET /api/podcasts/episodes/:id/key',
    request: (f, v) => get(`/api/podcasts/episodes/${f.episodeId}/key`, v),
    onPublic: SESSION_REQUIRED,
    onPrivate: SESSION_REQUIRED_OWNER_ONLY,
  },
  {
    name: 'GET /api/podcasts/episodes/:id/master.m3u8',
    request: (f, v) => get(`/api/podcasts/episodes/${f.episodeId}/master.m3u8`, v),
    onPublic: SESSION_REQUIRED,
    onPrivate: SESSION_REQUIRED_OWNER_ONLY,
  },
  {
    name: 'GET /api/podcasts/episodes/:id/v/:variant',
    request: (f, v) => get(`/api/podcasts/episodes/${f.episodeId}/v/${f.bitrateKbps}.m3u8`, v),
    onPublic: SESSION_REQUIRED,
    onPrivate: SESSION_REQUIRED_OWNER_ONLY,
  },
  {
    name: 'POST /api/podcasts/:id/subscribe',
    request: (f, v) => post(`/api/podcasts/${f.showId}/subscribe`, v),
    onPublic: AUTH_REQUIRED,
    onPrivate: AUTH_REQUIRED_OWNER_ONLY,
  },
  {
    name: 'PUT /api/episodes/:id/progress',
    request: (f, v) => put(`/api/episodes/${f.episodeId}/progress`, v, { positionSec: 10 }),
    onPublic: AUTH_REQUIRED,
    onPrivate: AUTH_REQUIRED_OWNER_ONLY,
  },
  {
    /**
     * 409 "not claimable" on the public show is the positive control here, not a
     * failure: the fixture is `claimable: false`, so a caller who CAN see the
     * show is refused on the claim rule. What must differ is the private show,
     * where a stranger gets 404 — the show's existence, and its claim state, are
     * both withheld.
     */
    name: 'POST /api/podcasts/:id/claim',
    request: (f, v) => post(`/api/podcasts/${f.showId}/claim`, v),
    onPublic: { anonymous: 401, stranger: 409, owner: 409 },
    onPrivate: { anonymous: 401, stranger: 404, owner: 409 },
  },
];

describe('the visibility matrix — every read surface, every viewer', () => {
  for (const surface of SURFACES) {
    it(`${surface.name} — public is the control, private is the measurement`, async () => {
      const { pub, priv } = await seedBoth();

      for (const viewer of ALL_VIEWERS) {
        const onPublic = await surface.request(pub, viewer);
        expect(`${surface.name} public/${viewer}: ${onPublic.status}`).toBe(
          `${surface.name} public/${viewer}: ${surface.onPublic[viewer]}`
        );

        const onPrivate = await surface.request(priv, viewer);
        expect(`${surface.name} private/${viewer}: ${onPrivate.status}`).toBe(
          `${surface.name} private/${viewer}: ${surface.onPrivate[viewer]}`
        );
      }
    });
  }
});

// ── Discovery surfaces: a status code says nothing, so assert the CONTENTS ────

interface Listing {
  readonly ids: string[];
  readonly status: number;
}

async function listedShowIds(path: string, viewer: ViewerName, pick: (body: unknown) => unknown[]): Promise<Listing> {
  const response = await get(path, viewer);
  const body: unknown = await response.json();
  const rows = pick(body);
  const ids = rows.flatMap((row) =>
    row && typeof row === 'object' && 'id' in row && typeof row.id === 'string' ? [row.id] : []
  );
  return { ids, status: response.status };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function dataArray(body: unknown): unknown[] {
  return body && typeof body === 'object' && 'data' in body ? asArray(body.data) : [];
}

function searchCategory(body: unknown, category: 'podcasts' | 'episodes'): unknown[] {
  if (!body || typeof body !== 'object' || !('results' in body)) return [];
  const results = body.results;
  if (!results || typeof results !== 'object' || !(category in results)) return [];
  return asArray((results as Record<string, unknown>)[category]);
}

describe('discovery surfaces list the public show and never the private one', () => {
  /**
   * A 200 proves nothing on a listing endpoint — it answers 200 with an empty
   * array just as happily — so every case here asserts the ID SET. The public
   * show's id being PRESENT is the positive control; the private show's id being
   * absent is the measurement, and neither can pass without the other.
   *
   * The OWNER row matters most and is the one a "filter by viewer" instinct gets
   * wrong: discovery is LISTABLE-only, so a creator does not find their own
   * private show in browse or search either. Their dashboard
   * (`GET /api/podcasts/mine`) is where it appears, and that is asserted below.
   */
  it('GET /api/podcasts — the browse shelf', async () => {
    const { pub, priv } = await seedBoth();

    for (const viewer of ALL_VIEWERS) {
      const listing = await listedShowIds('/api/podcasts', viewer, dataArray);
      expect(`browse/${viewer}: ${listing.status}`).toBe(`browse/${viewer}: 200`);
      expect(`browse/${viewer} public listed: ${listing.ids.includes(pub.showId)}`).toBe(
        `browse/${viewer} public listed: true`
      );
      expect(`browse/${viewer} private listed: ${listing.ids.includes(priv.showId)}`).toBe(
        `browse/${viewer} private listed: false`
      );
    }
  });

  it('GET /api/podcasts/search', async () => {
    const { pub, priv } = await seedBoth();

    for (const viewer of ALL_VIEWERS) {
      const listing = await listedShowIds(
        `/api/podcasts/search?q=${RARE_TERM}`,
        viewer,
        dataArray
      );
      expect(`podcast search/${viewer}: ${listing.status}`).toBe(`podcast search/${viewer}: 200`);
      expect(`podcast search/${viewer} public: ${listing.ids.includes(pub.showId)}`).toBe(
        `podcast search/${viewer} public: true`
      );
      expect(`podcast search/${viewer} private: ${listing.ids.includes(priv.showId)}`).toBe(
        `podcast search/${viewer} private: false`
      );
    }
  });

  it('GET /api/search?category=podcasts', async () => {
    const { pub, priv } = await seedBoth();

    for (const viewer of ALL_VIEWERS) {
      const listing = await listedShowIds(
        `/api/search?q=${RARE_TERM}&category=podcasts`,
        viewer,
        (body) => searchCategory(body, 'podcasts')
      );
      expect(`search podcasts/${viewer} public: ${listing.ids.includes(pub.showId)}`).toBe(
        `search podcasts/${viewer} public: true`
      );
      expect(`search podcasts/${viewer} private: ${listing.ids.includes(priv.showId)}`).toBe(
        `search podcasts/${viewer} private: false`
      );
    }
  });

  it('GET /api/search?category=episodes — the EPISODE half follows its show', async () => {
    const { pub, priv } = await seedBoth();

    for (const viewer of ALL_VIEWERS) {
      const listing = await listedShowIds(
        `/api/search?q=${RARE_TERM}&category=episodes`,
        viewer,
        (body) => searchCategory(body, 'episodes')
      );
      expect(`search episodes/${viewer} public: ${listing.ids.includes(pub.episodeId)}`).toBe(
        `search episodes/${viewer} public: true`
      );
      expect(`search episodes/${viewer} private: ${listing.ids.includes(priv.episodeId)}`).toBe(
        `search episodes/${viewer} private: false`
      );
    }
  });

  it('GET /api/p/:id — the appears-in shelf, both halves', async () => {
    const { pub, priv } = await seedBoth();
    const personId = await seedPerson();

    for (const viewer of ALL_VIEWERS) {
      const response = await get(`/api/p/${personId}`, viewer);
      expect(`person/${viewer}: ${response.status}`).toBe(`person/${viewer}: 200`);

      const body: unknown = await response.json();
      const appearsIn =
        body && typeof body === 'object' && 'data' in body &&
        body.data && typeof body.data === 'object' && 'appearsIn' in body.data
          ? body.data.appearsIn
          : undefined;

      const shows = appearsIn && typeof appearsIn === 'object' && 'podcasts' in appearsIn
        ? asArray(appearsIn.podcasts)
        : [];
      const eps = appearsIn && typeof appearsIn === 'object' && 'episodes' in appearsIn
        ? asArray(appearsIn.episodes)
        : [];

      const showIds = shows.flatMap((row) =>
        row && typeof row === 'object' && 'id' in row && typeof row.id === 'string' ? [row.id] : []
      );
      const episodeIds = eps.flatMap((row) =>
        row && typeof row === 'object' && 'id' in row && typeof row.id === 'string' ? [row.id] : []
      );

      expect(`appears-in shows/${viewer} public: ${showIds.includes(pub.showId)}`).toBe(
        `appears-in shows/${viewer} public: true`
      );
      expect(`appears-in shows/${viewer} private: ${showIds.includes(priv.showId)}`).toBe(
        `appears-in shows/${viewer} private: false`
      );
      expect(`appears-in episodes/${viewer} public: ${episodeIds.includes(pub.episodeId)}`).toBe(
        `appears-in episodes/${viewer} public: true`
      );
      expect(`appears-in episodes/${viewer} private: ${episodeIds.includes(priv.episodeId)}`).toBe(
        `appears-in episodes/${viewer} private: false`
      );
    }
  });

  it("GET /api/podcasts/mine — the owner's dashboard is the one unfiltered list", async () => {
    // The counterpart to every "the owner does not see it in discovery" case
    // above. Without this, "private is hidden everywhere" would be satisfied by a
    // change that simply lost the show, and the creator would have no way back.
    const { pub, priv } = await seedBoth();

    const listing = await listedShowIds('/api/podcasts/mine', 'owner', dataArray);
    expect(`mine: ${listing.status}`).toBe('mine: 200');
    expect(`mine public: ${listing.ids.includes(pub.showId)}`).toBe('mine public: true');
    expect(`mine private: ${listing.ids.includes(priv.showId)}`).toBe('mine private: true');

    const stranger = await listedShowIds('/api/podcasts/mine', 'stranger', dataArray);
    expect(`mine stranger: ${stranger.ids.length}`).toBe('mine stranger: 0');
  });
});

// ── The stream token is an identity, and it is checked as one ────────────────

describe("a private show's media through a ?t= stream token", () => {
  /**
   * The token arm of `isShowOwnerRequest`, which no bearer-based case above can
   * exercise: a native player fetches `/key` and `/v/:variant` from the URL
   * alone, so the token is the ONLY identity those requests carry.
   *
   * Three tokens, and each one isolates a different half of the check.
   */
  it('accepts the owner’s token, and no other', async () => {
    const { priv } = await seedBoth();
    const otherEpisode = (await seedShow('private')).episodeId;

    const ownerToken = mintStreamToken(
      { trackId: priv.episodeId, userId: OWNER, maxBitrateKbps: 160 },
      3600
    );
    const strangerToken = mintStreamToken(
      { trackId: priv.episodeId, userId: STRANGER, maxBitrateKbps: 160 },
      3600
    );
    const wrongEpisodeToken = mintStreamToken(
      { trackId: otherEpisode, userId: OWNER, maxBitrateKbps: 160 },
      3600
    );

    const key = `/api/podcasts/episodes/${priv.episodeId}/key`;

    const withOwner = await get(`${key}?t=${ownerToken}`, 'anonymous');
    expect(`owner token: ${withOwner.status}`).toBe('owner token: 200');

    // A perfectly valid token — right episode, right signature, wrong person.
    const withStranger = await get(`${key}?t=${strangerToken}`, 'anonymous');
    expect(`stranger token: ${withStranger.status}`).toBe('stranger token: 404');

    // The owner's own token, for a different episode.
    const withWrongEpisode = await get(`${key}?t=${wrongEpisodeToken}`, 'anonymous');
    expect(`wrong-episode token: ${withWrongEpisode.status}`).toBe('wrong-episode token: 404');
  });
});

// ── The DTO withholds owner-only fields ──────────────────────────────────────

describe('the show and episode DTOs are built for the viewer', () => {
  async function readShowDto(fixture: ShowFixture, viewer: ViewerName): Promise<Record<string, unknown>> {
    const response = await get(`/api/podcasts/${fixture.showId}`, viewer);
    expect(`show dto/${viewer}: ${response.status}`).toBe(`show dto/${viewer}: 200`);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('no data');
    const data = body.data;
    if (!data || typeof data !== 'object' || !('podcast' in data)) throw new Error('no podcast');
    return data.podcast as Record<string, unknown>;
  }

  it('withholds etag, lastModified and the true episode count from a non-owner', async () => {
    const { pub } = await seedBoth();
    await getDb()
      .update(podcasts)
      .set({ etag: 'W/"abc"', lastModified: 'Thu, 01 Jan 2026 00:00:00 GMT', episodeCount: 7 })
      .where(eq(podcasts.id, pub.showId));

    const owner = await readShowDto(pub, 'owner');
    // The positive control: the values really ARE stored, and the owner sees
    // them. Without this the absences below would pass against a show that
    // simply had no etag.
    expect(`owner etag: ${owner.etag}`).toBe('owner etag: W/"abc"');
    expect(`owner lastModified: ${typeof owner.lastModified}`).toBe('owner lastModified: string');
    expect(`owner episodeCount: ${owner.episodeCount}`).toBe('owner episodeCount: 7');

    for (const viewer of ['anonymous', 'stranger'] as const) {
      const dto = await readShowDto(pub, viewer);
      expect(`${viewer} etag: ${dto.etag}`).toBe(`${viewer} etag: undefined`);
      expect(`${viewer} lastModified: ${dto.lastModified}`).toBe(`${viewer} lastModified: undefined`);
      // ONE ready episode exists; the stored counter says seven.
      expect(`${viewer} episodeCount: ${dto.episodeCount}`).toBe(`${viewer} episodeCount: 1`);
    }
  });

  it('withholds feedUrl for a non-public show, and keeps it for a public one', async () => {
    const { pub, priv } = await seedBoth();

    // The positive control, on the same field: a PUBLIC show's feed URL is
    // public, so an absence on the private show means the visibility test fired
    // rather than the field having been dropped outright.
    const publicStranger = await readShowDto(pub, 'stranger');
    expect(`public feedUrl present: ${typeof publicStranger.feedUrl}`).toBe(
      'public feedUrl present: string'
    );

    const privateOwner = await readShowDto(priv, 'owner');
    expect(`private owner feedUrl: ${typeof privateOwner.feedUrl}`).toBe(
      'private owner feedUrl: string'
    );

    // An unlisted show is reachable by a stranger, and its feed URL is not.
    await setVisibility(priv.showId, 'unlisted');
    const unlistedStranger = await readShowDto(priv, 'stranger');
    expect(`unlisted feedUrl: ${unlistedStranger.feedUrl}`).toBe('unlisted feedUrl: undefined');
  });

  it('withholds hlsMasterKey and cache.s3Key from a non-owner episode DTO', async () => {
    const { pub } = await seedBoth();
    await getDb()
      .update(episodesTable)
      .set({ cacheStatus: 'cached', cacheObjectKey: 'cache/secret-object-key.mp3' })
      .where(eq(episodesTable.id, pub.episodeId));

    async function readEpisodeDto(viewer: ViewerName): Promise<Record<string, unknown>> {
      const response = await get(`/api/episodes/${pub.episodeId}`, viewer);
      expect(`episode dto/${viewer}: ${response.status}`).toBe(`episode dto/${viewer}: 200`);
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('no data');
      const data = body.data;
      if (!data || typeof data !== 'object' || !('episode' in data)) throw new Error('no episode');
      return data.episode as Record<string, unknown>;
    }

    const owner = await readEpisodeDto('owner');
    expect(`owner hlsMasterKey: ${typeof owner.hlsMasterKey}`).toBe('owner hlsMasterKey: string');
    const ownerCache = owner.cache as Record<string, unknown>;
    expect(`owner cache.s3Key: ${ownerCache.s3Key}`).toBe(
      'owner cache.s3Key: cache/secret-object-key.mp3'
    );

    for (const viewer of ['anonymous', 'stranger'] as const) {
      const dto = await readEpisodeDto(viewer);
      expect(`${viewer} hlsMasterKey: ${dto.hlsMasterKey}`).toBe(`${viewer} hlsMasterKey: undefined`);
      const cache = dto.cache as Record<string, unknown>;
      // `cache.status` survives — it is not storage layout — so an absent
      // `s3Key` here is the withholding rather than an absent `cache` object.
      expect(`${viewer} cache.status: ${cache.status}`).toBe(`${viewer} cache.status: cached`);
      expect(`${viewer} cache.s3Key: ${cache.s3Key}`).toBe(`${viewer} cache.s3Key: undefined`);
    }
  });
});

// ── unlisted is a third state, not a synonym for either neighbour ────────────

describe('unlisted is reachable by id and absent from every listing', () => {
  /**
   * The state that makes this a ladder rather than a boolean. Every assertion
   * pairs it against BOTH neighbours: if `unlisted` behaved as `public` the
   * listing halves would fail, and if it behaved as `private` the reachability
   * halves would.
   */
  it('resolves on its direct URLs for a stranger', async () => {
    const { priv } = await seedBoth();
    await setVisibility(priv.showId, 'unlisted');

    for (const path of [
      `/api/podcasts/${priv.showId}`,
      `/api/podcasts/${priv.showId}/episodes`,
      `/api/podcasts/${priv.showId}/rss`,
      `/api/episodes/${priv.episodeId}`,
      `/api/podcasts/episodes/${priv.episodeId}/audio`,
    ]) {
      const response = await get(path, 'stranger');
      expect(`unlisted ${path}: ${response.status}`).toBe(`unlisted ${path}: 200`);
    }
  });

  it('is absent from browse, podcast search and episode search', async () => {
    const { pub, priv } = await seedBoth();
    await setVisibility(priv.showId, 'unlisted');

    const browse = await listedShowIds('/api/podcasts', 'stranger', dataArray);
    expect(`unlisted in browse: ${browse.ids.includes(priv.showId)}`).toBe(
      'unlisted in browse: false'
    );
    expect(`public in browse: ${browse.ids.includes(pub.showId)}`).toBe('public in browse: true');

    const search = await listedShowIds(
      `/api/podcasts/search?q=${RARE_TERM}`,
      'stranger',
      dataArray
    );
    expect(`unlisted in search: ${search.ids.includes(priv.showId)}`).toBe(
      'unlisted in search: false'
    );
    expect(`public in search: ${search.ids.includes(pub.showId)}`).toBe('public in search: true');

    const episodes = await listedShowIds(
      `/api/search?q=${RARE_TERM}&category=episodes`,
      'stranger',
      (body) => searchCategory(body, 'episodes')
    );
    expect(`unlisted episode in search: ${episodes.ids.includes(priv.episodeId)}`).toBe(
      'unlisted episode in search: false'
    );
    expect(`public episode in search: ${episodes.ids.includes(pub.episodeId)}`).toBe(
      'public episode in search: true'
    );
  });
});

// ── The publish axis, which visibility does not replace ──────────────────────

describe('an UNPUBLISHED public show is unreachable too', () => {
  /**
   * `status` and `visibility` are separate columns and both are enforced. This
   * is the case that was broken before the change in its own right: `status =
   * 'unavailable'` was consulted by browse and search alone, so a show its
   * creator had unpublished kept serving its detail page, its episode list and
   * its full RSS feed on a direct link.
   *
   * The show here is `public`, so nothing about `visibility` can account for a
   * 404 — only the publish axis can.
   */
  it('404s on the direct URLs a public unpublished show used to serve', async () => {
    const { pub } = await seedBoth();

    // Positive control first, on the very same show.
    for (const path of [
      `/api/podcasts/${pub.showId}`,
      `/api/podcasts/${pub.showId}/episodes`,
      `/api/podcasts/${pub.showId}/rss`,
      `/api/episodes/${pub.episodeId}`,
    ]) {
      const before = await get(path, 'stranger');
      expect(`published ${path}: ${before.status}`).toBe(`published ${path}: 200`);
    }

    await getDb()
      .update(podcasts)
      .set({ status: 'unavailable' })
      .where(eq(podcasts.id, pub.showId));

    for (const path of [
      `/api/podcasts/${pub.showId}`,
      `/api/podcasts/${pub.showId}/episodes`,
      `/api/podcasts/${pub.showId}/rss`,
      `/api/episodes/${pub.episodeId}`,
    ]) {
      const after = await get(path, 'stranger');
      expect(`unpublished ${path}: ${after.status}`).toBe(`unpublished ${path}: 404`);
    }

    // And the owner keeps their own show, which is what makes republishing possible.
    const owner = await get(`/api/podcasts/${pub.showId}`, 'owner');
    expect(`unpublished owner: ${owner.status}`).toBe('unpublished owner: 200');
  });
});

// ── The public RSS feed carries only READY episodes ──────────────────────────

describe('the generated RSS feed', () => {
  it('drops processing and failed episodes, which it used to publish', async () => {
    const { pub } = await seedBoth();

    const processingId = uuidv7();
    const failedId = uuidv7();
    await getDb().insert(episodesTable).values([
      {
        id: processingId,
        podcastId: pub.showId,
        podcastTitle: 'Show',
        title: 'Still transcoding',
        guid: `guid-${processingId}`,
        pubDate: new Date('2026-01-02T00:00:00.000Z'),
        source: 'syra',
        status: 'processing',
      },
      {
        id: failedId,
        podcastId: pub.showId,
        podcastTitle: 'Show',
        title: 'Ingest failed',
        guid: `guid-${failedId}`,
        pubDate: new Date('2026-01-03T00:00:00.000Z'),
        source: 'syra',
        status: 'failed',
      },
    ]);

    const response = await get(`/api/podcasts/${pub.showId}/rss`, 'anonymous');
    expect(`rss: ${response.status}`).toBe('rss: 200');
    const xml = await response.text();

    // The positive control: the ready episode IS in the feed, so the two
    // absences below are the status filter rather than an empty feed.
    expect(`ready in feed: ${xml.includes(`${RARE_TERM} Episode`)}`).toBe('ready in feed: true');
    expect(`processing in feed: ${xml.includes('Still transcoding')}`).toBe(
      'processing in feed: false'
    );
    expect(`failed in feed: ${xml.includes('Ingest failed')}`).toBe('failed in feed: false');
  });
});

// ── The resume list follows the show ─────────────────────────────────────────

describe('continue listening', () => {
  it('drops an entry whose show went private, and keeps the public one', async () => {
    const { pub, priv } = await seedBoth();

    // Both shows are reachable by the stranger to begin with, so both entries
    // can be created — the private one is made private AFTER.
    await setVisibility(priv.showId, 'public');
    for (const episodeId of [pub.episodeId, priv.episodeId]) {
      const saved = await put(`/api/episodes/${episodeId}/progress`, 'stranger', {
        positionSec: 30,
        durationSec: 600,
      });
      expect(`progress ${episodeId}: ${saved.status}`).toBe(`progress ${episodeId}: 200`);
    }

    const before = await get('/api/episodes/continue', 'stranger');
    const beforeIds = episodeIdsIn(await before.json());
    expect(`before public: ${beforeIds.includes(pub.episodeId)}`).toBe('before public: true');
    expect(`before private: ${beforeIds.includes(priv.episodeId)}`).toBe('before private: true');

    await setVisibility(priv.showId, 'private');

    const after = await get('/api/episodes/continue', 'stranger');
    const afterIds = episodeIdsIn(await after.json());
    // The public entry is the control: the list did not simply empty.
    expect(`after public: ${afterIds.includes(pub.episodeId)}`).toBe('after public: true');
    expect(`after private: ${afterIds.includes(priv.episodeId)}`).toBe('after private: false');
  });

  function episodeIdsIn(body: unknown): string[] {
    return dataArray(body).flatMap((row) => {
      if (!row || typeof row !== 'object' || !('episode' in row)) return [];
      const episode = row.episode;
      if (!episode || typeof episode !== 'object' || !('id' in episode)) return [];
      return typeof episode.id === 'string' ? [episode.id] : [];
    });
  }
});
