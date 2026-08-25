/**
 * Deleting a show, and deleting one episode — what actually goes, and who is
 * refused.
 *
 * Both routes are irreversible and reach other people's rows, so this file is
 * written around two properties that a suite of happy paths cannot establish.
 *
 * ## Every refusal asserts THREE things, not one
 *
 * A 403 proves the handler answered 403. It does not prove nothing was deleted:
 * a handler that purges S3 and then refuses is a catastrophe that returns the
 * right status code. So every refusal below also asserts that the row is still
 * there AND that S3 was never asked for anything — and each is paired with the
 * same request succeeding for the party who IS entitled, so "refused" can never
 * be explained by the endpoint being broken for everyone.
 *
 * ## The scoping case is the one with no status code
 *
 * `deletes one episode without touching its siblings` is the test that would
 * catch a delete that swept `hls/{podcastId}/` instead of
 * `hls/{podcastId}/{episodeId}/`. Nothing about that mistake changes a status
 * code, a row count, or the deleted episode's own outcome — the request
 * succeeds, the right row goes, and the sibling's audio is silently gone from
 * the bucket. It is asserted on the PREFIXES the handler asked for, because
 * that is the only surface on which the difference is visible at all.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import {
  episodeHlsRenditions,
  episodeIngestTickets,
  episodeProgress,
  episodes as episodesTable,
  podcasts,
} from '../db/schema/podcasts';
import { trackKeys } from '../db/schema/trackKeys';
import { userPodcastSubscriptions } from '../db/schema/library';
import * as realS3 from '../services/s3Service';
import podcastsRoutes from './podcasts.routes';
import episodesRoutes from './episodes.routes';

process.env.INGEST_TOKEN_SECRET = 'test-secret-podcast-delete';

// ── The S3 boundary ───────────────────────────────────────────────────────────

/**
 * The real implementations captured BY VALUE before the mock is registered.
 *
 * `import * as realS3` is a LIVE binding: once `mock.module` replaces the
 * module, reading `realS3.deleteFromS3` returns THE FAKE, so a fake that
 * "delegates to the real one" re-enters itself. Copying each into a `const` at
 * module-init time freezes the reference — the same trap, and the same fix,
 * `podcastIngest.test.ts` records having hit.
 */
const realDeleteFromS3 = realS3.deleteFromS3;
const realDeleteS3Prefix = realS3.deleteS3Prefix;

/** What the handler asked S3 to remove, so "did the audio go" is observable. */
const deletedKeys: string[] = [];
const deletedPrefixes: string[] = [];
/** Show ids THIS suite created — the scope of the fake below. */
const suiteShowIds = new Set<string>();

/** Every key this suite's fixtures own contains their show id. */
const isSuiteOwned = (target: string): boolean =>
  [...suiteShowIds].some((id) => target.includes(id));

/**
 * `mock.module` is process-global, so the fake is scoped to this suite's own
 * shows and DELEGATES everything else to the real module. A blanket fake would
 * hand every later file in the run a no-op S3, silently changing suites that
 * assert on the real behaviour — `compliance/takedown` drives both of these
 * functions for real.
 */
mock.module('../services/s3Service', () => ({
  ...realS3,
  deleteFromS3: async (key: string) => {
    if (!isSuiteOwned(key)) return realDeleteFromS3(key);
    deletedKeys.push(key);
  },
  deleteS3Prefix: async (prefix: string) => {
    if (!isSuiteOwned(prefix)) return realDeleteS3Prefix(prefix);
    deletedPrefixes.push(prefix);
    return 0;
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OWNER = 'oxy-delete-owner';
const STRANGER = 'oxy-delete-stranger';
const LISTENER = 'oxy-delete-listener';
const VIEWER_HEADER = 'x-test-viewer';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await connectDb();

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

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await clearDb();
  deletedKeys.length = 0;
  deletedPrefixes.length = 0;
  suiteShowIds.clear();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectDb();
});

interface ShowOptions {
  readonly owner?: string | null;
  readonly source?: 'syra' | 'rss';
  readonly status?: 'active' | 'unavailable' | 'removed';
}

async function seedShow(options: ShowOptions = {}): Promise<string> {
  const id = uuidv7();
  suiteShowIds.add(id);
  await getDb().insert(podcasts).values({
    id,
    title: 'Delete Show',
    source: options.source ?? 'syra',
    status: options.status ?? 'active',
    ownerOxyUserId: options.owner === undefined ? OWNER : options.owner,
    feedUrl: `https://feeds.example.invalid/${id}.xml`,
    episodeCount: 0,
  });
  return id;
}

/**
 * An episode with a full storage footprint: source audio, an HLS master, a
 * rendition manifest, and the AES key that decrypts it.
 */
async function seedEpisode(
  showId: string,
  overrides: { readonly pubDate?: Date; readonly source?: 'syra' | 'rss' } = {}
): Promise<string> {
  const id = uuidv7();
  const pubDate = overrides.pubDate ?? new Date();

  await getDb().insert(episodesTable).values({
    id,
    podcastId: showId,
    podcastTitle: 'Delete Show',
    title: 'An Episode',
    guid: id,
    pubDate,
    source: overrides.source ?? 'syra',
    status: 'ready',
    audioSourceUrl: `/api/podcasts/episodes/${id}/audio`,
    audioSourceFormat: 'mp3',
    hlsMasterKey: `hls/${showId}/${id}/master.m3u8`,
  });
  await getDb().insert(episodeHlsRenditions).values({
    id: uuidv7(),
    episodeId: id,
    position: 0,
    manifestKey: `hls/${showId}/${id}/96/index.m3u8`,
    bitrateKbps: 96,
    encrypted: true,
  });
  await getDb().insert(trackKeys).values({
    id: uuidv7(),
    episodeId: id,
    keyHex: 'deadbeefdeadbeefdeadbeefdeadbeef',
    keyUri: `/api/podcasts/episodes/${id}/key`,
  });

  const [show] = await getDb()
    .select({ count: podcasts.episodeCount })
    .from(podcasts)
    .where(eq(podcasts.id, showId));
  await getDb()
    .update(podcasts)
    .set({ episodeCount: (show?.count ?? 0) + 1, lastEpisodeAt: pubDate })
    .where(eq(podcasts.id, showId));

  return id;
}

function request(
  path: string,
  method: string,
  viewer?: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(viewer ? { [VIEWER_HEADER]: viewer } : {}), ...headers },
  });
}

const showExists = async (id: string): Promise<boolean> =>
  (await getDb().select({ id: podcasts.id }).from(podcasts).where(eq(podcasts.id, id))).length > 0;

const episodeExists = async (id: string): Promise<boolean> =>
  (await getDb().select({ id: episodesTable.id }).from(episodesTable).where(eq(episodesTable.id, id)))
    .length > 0;

/** Every S3 call the handler made, so "it touched storage at all" is one check. */
const touchedStorage = (): number => deletedKeys.length + deletedPrefixes.length;

// ── Deleting a show ───────────────────────────────────────────────────────────

describe('DELETE /api/podcasts/:id', () => {
  it('deletes the show, its episodes, and everything that referenced them', async () => {
    const showId = await seedShow();
    const episodeId = await seedEpisode(showId);

    await getDb().insert(userPodcastSubscriptions).values({
      id: uuidv7(),
      oxyUserId: LISTENER,
      podcastId: showId,
    });
    await getDb().insert(episodeProgress).values({
      id: uuidv7(),
      oxyUserId: LISTENER,
      episodeId,
      positionSec: 42,
    });
    await getDb().insert(episodeIngestTickets).values({
      id: uuidv7(),
      jti: uuidv7(),
      episodeId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const response = await request(`/api/podcasts/${showId}`, 'DELETE', OWNER);
    expect(response.status).toBe(200);

    expect(await showExists(showId)).toBe(false);
    expect(await episodeExists(episodeId)).toBe(false);

    // The cascade, asserted rather than assumed — including the two tables that
    // hold OTHER people's rows.
    expect(
      (await getDb().select().from(userPodcastSubscriptions)).length,
      'every subscriber\'s subscription'
    ).toBe(0);
    expect(
      (await getDb().select().from(episodeProgress)).length,
      'every listener\'s saved position'
    ).toBe(0);
    expect((await getDb().select().from(trackKeys)).length, 'the AES keys').toBe(0);
    expect(
      (await getDb().select().from(episodeIngestTickets)).length,
      'any outstanding ingest capability'
    ).toBe(0);
    expect((await getDb().select().from(episodeHlsRenditions)).length, 'the HLS ladder').toBe(0);
  });

  it("sweeps the show's three storage trees and its episodes' source audio", async () => {
    const showId = await seedShow();
    const episodeId = await seedEpisode(showId);

    const response = await request(`/api/podcasts/${showId}`, 'DELETE', OWNER);
    expect(response.status).toBe(200);

    // The row being gone is not evidence the audio is: these are the only
    // assertions that can tell a delete from a hide.
    expect(deletedPrefixes).toContain(`hls/${showId}/`);
    expect(deletedPrefixes).toContain(`podcasts/audio/${showId}/`);
    expect(deletedPrefixes).toContain(`podcasts/cache/${showId}/`);

    /**
     * Every object the episode owns is REACHED — each either swept by one of the
     * prefixes above or deleted by key. Asserted as coverage rather than as "a
     * call mentioning the episode id happened", because for a show delete the
     * correct behaviour is that the prefixes already cover all three: an
     * assertion that demanded a per-episode call would fail against a correct
     * implementation and pass against one that deleted each key twice.
     *
     * The source audio is the one that matters most here — its key is recorded
     * in NO column (`audio_source_url` holds an API path), so it is reachable
     * only if the delete derives it the way ingest wrote it.
     */
    const ownedObjects = [
      `podcasts/audio/${showId}/${episodeId}.mp3`,
      `hls/${showId}/${episodeId}/master.m3u8`,
      `hls/${showId}/${episodeId}/96/index.m3u8`,
    ];
    for (const key of ownedObjects) {
      const reached =
        deletedKeys.includes(key) || deletedPrefixes.some((prefix) => key.startsWith(prefix));
      expect(reached, `${key} must not survive the show`).toBe(true);
    }
  });

  it('refuses a stranger, keeps the row, and never touches storage', async () => {
    const showId = await seedShow();
    await seedEpisode(showId);

    const refused = await request(`/api/podcasts/${showId}`, 'DELETE', STRANGER);
    expect(refused.status).toBe(403);
    expect(await showExists(showId)).toBe(true);
    expect(touchedStorage(), 'a refusal must not reach S3').toBe(0);

    // The positive control: the SAME request from the owner succeeds, so the
    // 403 above cannot be explained by the endpoint being broken.
    const allowed = await request(`/api/podcasts/${showId}`, 'DELETE', OWNER);
    expect(allowed.status).toBe(200);
    expect(await showExists(showId)).toBe(false);
  });

  it('refuses an RSS-mirrored show even to a caller recorded as its owner', async () => {
    /**
     * `ownerOxyUserId` is set to the caller deliberately. An RSS show never gets
     * one through `claimPodcast` (it refuses `source === 'rss'`), so a fixture
     * with a null owner would be refused by the OWNERSHIP arm and prove nothing
     * about the `source` arm. Setting it is what makes this test able to fail if
     * the `source === 'syra'` check is removed.
     */
    const mirrored = await seedShow({ source: 'rss', owner: OWNER });
    const own = await seedShow({ source: 'syra', owner: OWNER });

    const refused = await request(`/api/podcasts/${mirrored}`, 'DELETE', OWNER);
    expect(refused.status).toBe(403);
    expect(await showExists(mirrored), 'the catalogue entry survives').toBe(true);
    expect(touchedStorage()).toBe(0);

    // Positive control: the same caller, the same request, a Syra-hosted show.
    expect((await request(`/api/podcasts/${own}`, 'DELETE', OWNER)).status).toBe(200);
  });

  it('refuses an unauthenticated caller', async () => {
    const showId = await seedShow();

    const refused = await request(`/api/podcasts/${showId}`, 'DELETE');
    expect(refused.status).toBe(401);
    expect(await showExists(showId)).toBe(true);
    expect(touchedStorage()).toBe(0);

    expect((await request(`/api/podcasts/${showId}`, 'DELETE', OWNER)).status).toBe(200);
  });

  it('refuses a show the platform removed, so a takedown record survives', async () => {
    const removed = await seedShow({ status: 'removed' });
    const active = await seedShow({ status: 'active' });

    const refused = await request(`/api/podcasts/${removed}`, 'DELETE', OWNER);
    expect(refused.status).toBe(409);
    expect(await showExists(removed)).toBe(true);
    expect(touchedStorage()).toBe(0);

    expect((await request(`/api/podcasts/${active}`, 'DELETE', OWNER)).status).toBe(200);
  });
});

// ── The ingest capability ─────────────────────────────────────────────────────

describe('the ingest ticket', () => {
  it('cannot delete anything, while still being a live capability', async () => {
    const showId = await seedShow();

    const drafted = await fetch(`${baseUrl}/api/podcasts/${showId}/episodes/draft`, {
      method: 'POST',
      headers: { [VIEWER_HEADER]: OWNER, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Drafted' }),
    });
    expect(drafted.status).toBe(201);
    const { data } = (await drafted.json()) as {
      data: { episodeId: string; ingestTicket: string };
    };

    /**
     * The positive control, and it is what makes the two refusals below mean
     * something: this proves the ticket AUTHENTICATES. `400 Audio file is
     * required` is reached only after `authorizeIngest` has verified the token,
     * bound it to this episode, and matched the show's current owner — so the
     * ticket is live at the moment the deletes are attempted.
     */
    const ingest = await fetch(`${baseUrl}/api/podcasts/episodes/${data.episodeId}/ingest`, {
      method: 'POST',
      headers: { 'x-ingest-ticket': data.ingestTicket },
    });
    expect(ingest.status, 'the ticket is authentic and unspent').toBe(400);

    const episode = await request(`/api/episodes/${data.episodeId}`, 'DELETE', undefined, {
      'x-ingest-ticket': data.ingestTicket,
    });
    expect(episode.status, 'a ticket is not a session').toBe(401);

    const show = await request(`/api/podcasts/${showId}`, 'DELETE', undefined, {
      'x-ingest-ticket': data.ingestTicket,
    });
    expect(show.status).toBe(401);

    expect(await showExists(showId)).toBe(true);
    expect(await episodeExists(data.episodeId)).toBe(true);
    expect(touchedStorage()).toBe(0);
  });
});

// ── Deleting one episode ──────────────────────────────────────────────────────

describe('DELETE /api/episodes/:id', () => {
  it('deletes one episode without touching its siblings', async () => {
    const showId = await seedShow();
    const older = await seedEpisode(showId, { pubDate: new Date('2026-01-01T00:00:00Z') });
    const newer = await seedEpisode(showId, { pubDate: new Date('2026-06-01T00:00:00Z') });

    const response = await request(`/api/episodes/${newer}`, 'DELETE', OWNER);
    expect(response.status).toBe(200);

    expect(await episodeExists(newer)).toBe(false);
    expect(await episodeExists(older), 'the sibling survives').toBe(true);

    /**
     * The assertion this whole file exists for. Sweeping `hls/{showId}/` would
     * delete the sibling's audio too — the request would still return 200, the
     * right row would still be gone, and the sibling row would still be there.
     * The prefix is the only place the mistake is visible.
     */
    expect(deletedPrefixes).toContain(`hls/${showId}/${newer}/`);
    expect(deletedPrefixes, 'never the whole show').not.toContain(`hls/${showId}/`);
    expect(
      deletedKeys.concat(deletedPrefixes).some((target) => target.includes(older)),
      "nothing belonging to the sibling episode"
    ).toBe(false);

    /**
     * The SOURCE audio, asserted separately because it is the one object an
     * episode delete can silently leave behind. It lives under
     * `podcasts/audio/…`, which the episode's `hls/…` prefix does not cover, and
     * its key is recorded in no column — so it goes only if the delete derives
     * it. Measured: without this assertion, removing the derivation entirely
     * left all thirteen tests green, because a SHOW delete reaches the same
     * object through its `podcasts/audio/{showId}/` sweep and hid the gap.
     */
    expect(deletedKeys, 'the source audio is not under the HLS prefix').toContain(
      `podcasts/audio/${showId}/${newer}.mp3`
    );
  });

  it("recomputes the show's derived counters", async () => {
    const showId = await seedShow();
    await seedEpisode(showId, { pubDate: new Date('2026-01-01T00:00:00Z') });
    const newer = await seedEpisode(showId, { pubDate: new Date('2026-06-01T00:00:00Z') });

    const [before] = await getDb()
      .select({ count: podcasts.episodeCount, last: podcasts.lastEpisodeAt })
      .from(podcasts)
      .where(eq(podcasts.id, showId));
    expect(before?.count).toBe(2);
    expect(before?.last?.toISOString()).toBe('2026-06-01T00:00:00.000Z');

    expect((await request(`/api/episodes/${newer}`, 'DELETE', OWNER)).status).toBe(200);

    const [after] = await getDb()
      .select({ count: podcasts.episodeCount, last: podcasts.lastEpisodeAt })
      .from(podcasts)
      .where(eq(podcasts.id, showId));
    expect(after?.count).toBe(1);
    // `last_episode_at` cannot be decremented — deleting the newest has to find
    // the next newest, which is the older episode's date.
    expect(after?.last?.toISOString(), 'moves back to the next newest').toBe(
      '2026-01-01T00:00:00.000Z'
    );
  });

  it('refuses a stranger, keeps the row, and never touches storage', async () => {
    const showId = await seedShow();
    const episodeId = await seedEpisode(showId);

    const refused = await request(`/api/episodes/${episodeId}`, 'DELETE', STRANGER);
    expect(refused.status).toBe(403);
    expect(await episodeExists(episodeId)).toBe(true);
    expect(touchedStorage()).toBe(0);

    expect((await request(`/api/episodes/${episodeId}`, 'DELETE', OWNER)).status).toBe(200);
    expect(await episodeExists(episodeId)).toBe(false);
  });

  it('refuses an episode of an RSS-mirrored show', async () => {
    const mirrored = await seedShow({ source: 'rss', owner: OWNER });
    const mirroredEpisode = await seedEpisode(mirrored, { source: 'rss' });
    const own = await seedShow({ source: 'syra', owner: OWNER });
    const ownEpisode = await seedEpisode(own);

    const refused = await request(`/api/episodes/${mirroredEpisode}`, 'DELETE', OWNER);
    expect(refused.status).toBe(403);
    expect(await episodeExists(mirroredEpisode)).toBe(true);
    expect(touchedStorage()).toBe(0);

    expect((await request(`/api/episodes/${ownEpisode}`, 'DELETE', OWNER)).status).toBe(200);
  });

  it('refuses an unauthenticated caller', async () => {
    const showId = await seedShow();
    const episodeId = await seedEpisode(showId);

    const refused = await request(`/api/episodes/${episodeId}`, 'DELETE');
    expect(refused.status).toBe(401);
    expect(await episodeExists(episodeId)).toBe(true);
    expect(touchedStorage()).toBe(0);

    expect((await request(`/api/episodes/${episodeId}`, 'DELETE', OWNER)).status).toBe(200);
  });

  it('refuses an episode of a show the platform removed', async () => {
    const removed = await seedShow({ status: 'removed' });
    const removedEpisode = await seedEpisode(removed);
    const active = await seedShow({ status: 'active' });
    const activeEpisode = await seedEpisode(active);

    const refused = await request(`/api/episodes/${removedEpisode}`, 'DELETE', OWNER);
    expect(refused.status).toBe(409);
    expect(await episodeExists(removedEpisode)).toBe(true);
    expect(touchedStorage()).toBe(0);

    expect((await request(`/api/episodes/${activeEpisode}`, 'DELETE', OWNER)).status).toBe(200);
  });
});
