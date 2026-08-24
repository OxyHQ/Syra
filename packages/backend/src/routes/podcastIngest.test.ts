/**
 * The ingest capability at the ENDPOINT — what an authentic ticket may actually
 * do to an episode, and when.
 *
 * `services/podcasts/ingestToken.test.ts` covers whether a token is authentic.
 * Every ticket here IS authentic and minted by the real draft endpoint; what is
 * under test is the redemption gate. The two are separate files so a passing
 * case cannot be explained by the wrong layer.
 *
 * ## Every refusal is paired with its positive control
 *
 * The redemption path answers 401/404/409 in nine different ways, and a suite of
 * nothing but refusals passes just as happily against an endpoint that is simply
 * broken. So each case drafts a ticket, proves the HAPPY path first or beside
 * it, and only then breaks one thing.
 *
 * ## The restart case is the reason the ticket lives in Postgres
 *
 * A Redis nonce would not survive an eviction, a failover or a deploy, and every
 * outstanding ticket would silently become replayable with nothing reporting it.
 * `replay survives a process restart` drops the database pool and reopens it —
 * which is what a restart does to this process's state — and then replays. Its
 * control is a FRESH ticket redeemed after the same restart, so "the replay
 * failed" cannot be explained by the restart having broken everything.
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
  episodeIngestTickets,
  episodes as episodesTable,
  podcasts,
} from '../db/schema/podcasts';
import * as realS3 from '../services/s3Service';
import * as realIngest from '../services/podcasts/ingestEpisode';
import podcastsRoutes from './podcasts.routes';

process.env.INGEST_TOKEN_SECRET = 'test-secret-podcast-ingest-endpoint';

// ── The two boundaries this suite must not cross ──────────────────────────────

/** Object keys the handler asked S3 to store, so "did it upload" is observable. */
const storedKeys: string[] = [];
/** Episode ids handed to the transcode queue, so "did it enqueue" is observable. */
const enqueuedEpisodeIds: string[] = [];
/** Episode ids THIS suite created — the scope of both fakes below. */
const suiteEpisodeIds = new Set<string>();

/**
 * `mock.module` is process-global, so both fakes are scoped to this suite's own
 * rows and DELEGATE everything else to the real module. A blanket fake would
 * hand every later file in the run a working S3 and a no-op transcode queue,
 * silently changing suites that assert on the real behaviour of either —
 * `services/podcasts/ingestEpisode.test.ts` tests the real `enqueueEpisodeIngest`
 * two directories away.
 */
mock.module('../services/s3Service', () => ({
  ...realS3,
  uploadToS3: async (key: string, body: unknown, options?: unknown) => {
    if (![...suiteEpisodeIds].some((id) => key.includes(id))) {
      return realS3.uploadToS3(key, body as Parameters<typeof realS3.uploadToS3>[1], options as Parameters<typeof realS3.uploadToS3>[2]);
    }
    storedKeys.push(key);
  },
}));

mock.module('../services/podcasts/ingestEpisode', () => ({
  ...realIngest,
  enqueueEpisodeIngest: (episodeId: string) => {
    if (!suiteEpisodeIds.has(episodeId)) {
      realIngest.enqueueEpisodeIngest(episodeId);
      return;
    }
    enqueuedEpisodeIds.push(episodeId);
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OWNER = 'oxy-ingest-owner';
const STRANGER = 'oxy-ingest-stranger';
const VIEWER_HEADER = 'x-test-viewer';
const TICKET_HEADER = 'x-ingest-ticket';

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

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await clearDb();
  storedKeys.length = 0;
  enqueuedEpisodeIds.length = 0;
  suiteEpisodeIds.clear();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectDb();
});

async function seedShow(ownerOxyUserId: string = OWNER): Promise<string> {
  const id = uuidv7();
  await getDb().insert(podcasts).values({
    id,
    title: 'Ingest Show',
    source: 'syra',
    status: 'active',
    ownerOxyUserId,
    feedUrl: `https://feeds.example.invalid/${id}.xml`,
  });
  return id;
}

interface Draft {
  episodeId: string;
  ingestTicket: string;
  expiresAt: string;
}

/** The real draft endpoint — every ticket in this file is minted by the code under test. */
async function draft(
  showId: string,
  viewer: string = OWNER,
  body: Record<string, unknown> = { title: 'An Episode' }
): Promise<{ status: number; draft?: Draft }> {
  const response = await fetch(`${baseUrl}/api/podcasts/${showId}/episodes/draft`, {
    method: 'POST',
    headers: { [VIEWER_HEADER]: viewer, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status !== 201) return { status: response.status };
  const payload = (await response.json()) as { data: Draft };
  suiteEpisodeIds.add(payload.data.episodeId);
  return { status: response.status, draft: payload.data };
}

/** Redeem a ticket with a real multipart body. */
async function ingest(
  episodeId: string,
  ticket: string | undefined,
  fields: Record<string, string> = {}
): Promise<Response> {
  const form = new FormData();
  form.append('audioFile', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' }), 'episode.mp3');
  for (const [key, value] of Object.entries(fields)) form.append(key, value);

  return fetch(`${baseUrl}/api/podcasts/episodes/${episodeId}/ingest`, {
    method: 'POST',
    headers: ticket === undefined ? {} : { [TICKET_HEADER]: ticket },
    body: form,
  });
}

async function readEpisode(id: string) {
  const [row] = await getDb()
    .select()
    .from(episodesTable)
    .where(eq(episodesTable.id, id))
    .limit(1);
  return row;
}

async function readTicket(jti: string) {
  const [row] = await getDb()
    .select()
    .from(episodeIngestTickets)
    .where(eq(episodeIngestTickets.jti, jti))
    .limit(1);
  return row;
}

// ── The draft half ────────────────────────────────────────────────────────────

describe('POST /api/podcasts/:id/episodes/draft', () => {
  it('creates a processing episode with no audio, and records the ticket', async () => {
    const showId = await seedShow();
    const created = await draft(showId, OWNER, {
      title: 'Numbered Episode',
      season: 2,
      episodeNumber: 14,
      aiGenerated: true,
    });

    expect(`draft status: ${created.status}`).toBe('draft status: 201');
    const drafted = created.draft;
    if (!drafted) throw new Error('no draft in response');
    expect(`ticket present: ${drafted.ingestTicket.length > 0}`).toBe('ticket present: true');
    expect(`expiry parses: ${!Number.isNaN(Date.parse(drafted.expiresAt))}`).toBe(
      'expiry parses: true'
    );

    const episode = await readEpisode(drafted.episodeId);
    expect(`status: ${episode?.status}`).toBe('status: processing');
    // No audio yet, and no duration invented for it.
    expect(`format: ${episode?.audioSourceFormat}`).toBe('format: null');
    expect(`duration: ${episode?.duration}`).toBe('duration: 0');
    // The metadata the AUTHENTICATED user set — the fields a ticket can never touch.
    expect(`season: ${episode?.season}`).toBe('season: 2');
    expect(`episodeNumber: ${episode?.episodeNumber}`).toBe('episodeNumber: 14');
    expect(`aiGenerated: ${episode?.aiGenerated}`).toBe('aiGenerated: true');

    // The row and the episode land together — a ticket with no row can never be
    // redeemed, because the claim treats a missing row as refused.
    const tickets = await getDb().select().from(episodeIngestTickets);
    expect(`tickets: ${tickets.length}`).toBe('tickets: 1');
    expect(`ticket episode: ${tickets[0]?.episodeId === drafted.episodeId}`).toBe(
      'ticket episode: true'
    );
    expect(`consumed: ${tickets[0]?.consumedAt}`).toBe('consumed: null');
  });

  it('bumps the show counters, so the drafted episode is accounted for', async () => {
    const showId = await seedShow();
    await draft(showId);

    const [show] = await getDb().select().from(podcasts).where(eq(podcasts.id, showId));
    expect(`episodeCount: ${show?.episodeCount}`).toBe('episodeCount: 1');
  });

  it('refuses a stranger and a nonexistent show with the SAME answer', async () => {
    const showId = await seedShow();

    // Positive control: the owner can.
    expect(`owner: ${(await draft(showId, OWNER)).status}`).toBe('owner: 201');

    // 403 for both, so a draft attempt cannot be used to probe for a show's id.
    expect(`stranger: ${(await draft(showId, STRANGER)).status}`).toBe('stranger: 403');
    expect(`missing: ${(await draft(uuidv7(), OWNER)).status}`).toBe('missing: 403');
  });

  it('refuses an RSS-mirrored show — its fields are overwritten by the next crawl', async () => {
    const id = uuidv7();
    await getDb()
      .insert(podcasts)
      .values({ id, title: 'Mirror', source: 'rss', ownerOxyUserId: OWNER });

    expect(`rss: ${(await draft(id, OWNER)).status}`).toBe('rss: 403');
  });

  it('requires a title', async () => {
    const showId = await seedShow();
    expect(`no title: ${(await draft(showId, OWNER, {})).status}`).toBe('no title: 400');
    expect(`blank title: ${(await draft(showId, OWNER, { title: '   ' })).status}`).toBe(
      'blank title: 400'
    );
  });
});

// ── The redemption half ───────────────────────────────────────────────────────

describe('POST /api/podcasts/episodes/:id/ingest — the happy path', () => {
  it('attaches the audio, sets the allowlisted metadata and enqueues the transcode', async () => {
    const showId = await seedShow();
    const created = await draft(showId);
    const drafted = created.draft;
    if (!drafted) throw new Error('no draft');

    const response = await ingest(drafted.episodeId, drafted.ingestTicket, {
      duration: '1834.5',
      season: '3',
      episodeNumber: '7',
      description: 'Generated description',
      summary: 'Generated summary',
    });

    // 202, not 201: the episode exists but its audio is still being packaged.
    expect(`ingest status: ${response.status}`).toBe('ingest status: 202');

    const episode = await readEpisode(drafted.episodeId);
    expect(`format: ${episode?.audioSourceFormat}`).toBe('format: mp3');
    expect(`duration: ${episode?.duration}`).toBe('duration: 1834.5');
    expect(`season: ${episode?.season}`).toBe('season: 3');
    expect(`episodeNumber: ${episode?.episodeNumber}`).toBe('episodeNumber: 7');
    expect(`description: ${episode?.description}`).toBe('description: Generated description');
    expect(`summary: ${episode?.summary}`).toBe('summary: Generated summary');
    expect(`status: ${episode?.status}`).toBe('status: processing');

    // The audio really went to the deterministic per-episode key, and the
    // transcode really was queued — both observable, not assumed.
    expect(`stored: ${storedKeys.length}`).toBe('stored: 1');
    expect(`key names episode: ${storedKeys[0]?.includes(drafted.episodeId)}`).toBe(
      'key names episode: true'
    );
    expect(`enqueued: ${enqueuedEpisodeIds.join(',')}`).toBe(`enqueued: ${drafted.episodeId}`);
  });

  it('does not carry a NON-owner the storage keys back in the response', async () => {
    // The redeemer holds a capability, not the owner's identity, so the response
    // is the listener's view. A worker has no use for `hlsMasterKey`, and handing
    // it back would turn a write capability into a read of internal layout.
    const showId = await seedShow();
    const created = await draft(showId);
    const drafted = created.draft;
    if (!drafted) throw new Error('no draft');

    await getDb()
      .update(episodesTable)
      .set({ cacheStatus: 'cached', cacheObjectKey: 'cache/secret.mp3' })
      .where(eq(episodesTable.id, drafted.episodeId));

    const response = await ingest(drafted.episodeId, drafted.ingestTicket);
    const body = (await response.json()) as { data: Record<string, unknown> };
    const cache = body.data.cache as Record<string, unknown> | undefined;

    expect(`hlsMasterKey: ${body.data.hlsMasterKey}`).toBe('hlsMasterKey: undefined');
    // The positive control on the same object: `cache.status` IS returned, so an
    // absent `s3Key` is the withholding rather than an absent `cache`.
    expect(`cache.status: ${cache?.status}`).toBe('cache.status: cached');
    expect(`cache.s3Key: ${cache?.s3Key}`).toBe('cache.s3Key: undefined');
  });
});

describe('the redemption gate refuses', () => {
  /** A drafted episode plus its ticket, and the assurance that it WOULD work. */
  async function drafted(): Promise<Draft> {
    const showId = await seedShow();
    const created = await draft(showId);
    if (!created.draft) throw new Error('no draft');
    return created.draft;
  }

  it('no ticket at all — and says so, rather than falling through to "invalid"', async () => {
    const d = await drafted();
    const response = await ingest(d.episodeId, undefined);
    expect(`no header: ${response.status}`).toBe('no header: 401');

    /**
     * The MESSAGE, not just the status, and that is not pedantry: mutation-tested,
     * removing the missing-header guard entirely still produced a 401, because
     * `jwt.verify(undefined)` throws and the verifier answers `null`. The two
     * layers agree on the status and disagree on the reason, so the status alone
     * cannot tell whether the first one is there at all.
     */
    const body = (await response.json()) as { error?: string };
    expect(`no header reason: ${body.error}`).toBe('no header reason: Ingest ticket required');

    const bad = await ingest(d.episodeId, 'not-a-jwt');
    const badBody = (await bad.json()) as { error?: string };
    expect(`bad token reason: ${badBody.error}`).toBe('bad token reason: Invalid ingest ticket');

    // Positive control: the same request WITH the ticket works.
    expect(`with ticket: ${(await ingest(d.episodeId, d.ingestTicket)).status}`).toBe(
      'with ticket: 202'
    );
  });

  it('a ticket for a DIFFERENT episode, both of them ingestible', async () => {
    /**
     * Two real episodes on two real shows, both `processing`, both owned by the
     * same person — so the ONLY thing that can separate them is the binding in
     * the ticket. 404, not 403: a holder pointing a valid ticket at somebody
     * else's episode must not learn whether it exists.
     */
    const first = await drafted();
    const second = await drafted();

    expect(`crossed: ${(await ingest(second.episodeId, first.ingestTicket)).status}`).toBe(
      'crossed: 404'
    );
    // Nothing was written to the episode the ticket was pointed at.
    expect(`no upload: ${storedKeys.length}`).toBe('no upload: 0');

    // And each ticket still works on its OWN episode, which is what says the
    // refusal above was the binding and not a broken fixture.
    expect(`first on first: ${(await ingest(first.episodeId, first.ingestTicket)).status}`).toBe(
      'first on first: 202'
    );
    expect(`second on second: ${(await ingest(second.episodeId, second.ingestTicket)).status}`).toBe(
      'second on second: 202'
    );
  });

  it('a ticket for a different episode OF THE SAME SHOW', async () => {
    /**
     * The case the two-show version above cannot reach, and the more dangerous
     * of the two: when both episodes belong to one show, `podcastId` matches, the
     * owner matches, and both are `processing` — so the ONLY thing left is the
     * `episodeId` comparison.
     *
     * Mutation-proven: with the two-show test alone, deleting the `episodeId`
     * check entirely left this suite green, because the `podcastId` comparison
     * was quietly doing the work. This is the case that fails when it is gone.
     */
    const showId = await seedShow();
    const one = await draft(showId);
    const two = await draft(showId);
    if (!one.draft || !two.draft) throw new Error('no draft');

    expect(
      `same show crossed: ${(await ingest(two.draft.episodeId, one.draft.ingestTicket)).status}`
    ).toBe('same show crossed: 404');
    expect(`no upload: ${storedKeys.length}`).toBe('no upload: 0');

    // Both tickets still work on their own episode.
    expect(`one: ${(await ingest(one.draft.episodeId, one.draft.ingestTicket)).status}`).toBe(
      'one: 202'
    );
    expect(`two: ${(await ingest(two.draft.episodeId, two.draft.ingestTicket)).status}`).toBe(
      'two: 202'
    );
  });

  it('a ticket whose ROW has expired, though its JWT has not', async () => {
    /**
     * The row's deadline is enforced independently of the token's, and this is
     * the only case that can see it: every other expiry case here is refused by
     * `verifyIngestTicket` first.
     *
     * It matters for two reasons. The row is ours and the token is the holder's
     * copy, so the row is the one that decides — and it is what makes the expiry
     * sweep (`db/expiry.ts`) safe, since a swept row and a stale row are the same
     * refusal. Mutation-proven: dropping `expires_at > now()` from the claim left
     * this suite green until this case existed.
     */
    const d = await drafted();
    const jti = JSON.parse(atob(d.ingestTicket.split('.')[1])).jti as string;

    await getDb()
      .update(episodeIngestTickets)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(episodeIngestTickets.jti, jti));

    expect(`stale row: ${(await ingest(d.episodeId, d.ingestTicket)).status}`).toBe(
      'stale row: 409'
    );
    expect(`no upload: ${storedKeys.length}`).toBe('no upload: 0');

    // The control: put the deadline back and the same token works, so the
    // refusal was the row and not the token.
    await getDb()
      .update(episodeIngestTickets)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(episodeIngestTickets.jti, jti));
    expect(`revived: ${(await ingest(d.episodeId, d.ingestTicket)).status}`).toBe('revived: 202');
  });

  it('a ticket whose row was SWEPT away entirely', async () => {
    // The same rule from the other direction, and the property that lets the
    // expiry sweep delete rows without ever widening access: a MISSING row is a
    // refusal, not a pass.
    const d = await drafted();
    await getDb().delete(episodeIngestTickets);

    expect(`swept: ${(await ingest(d.episodeId, d.ingestTicket)).status}`).toBe('swept: 409');
    expect(`no upload: ${storedKeys.length}`).toBe('no upload: 0');
  });

  it('a REPLAY of a ticket that already worked', async () => {
    const d = await drafted();

    expect(`first use: ${(await ingest(d.episodeId, d.ingestTicket)).status}`).toBe(
      'first use: 202'
    );
    expect(`replay: ${(await ingest(d.episodeId, d.ingestTicket)).status}`).toBe('replay: 409');
    // The replay uploaded nothing — the claim is ahead of the upload on purpose.
    expect(`uploads: ${storedKeys.length}`).toBe('uploads: 1');
  });

  it('a replay AFTER A PROCESS RESTART — the whole reason this is not in Redis', async () => {
    const d = await drafted();
    expect(`first use: ${(await ingest(d.episodeId, d.ingestTicket)).status}`).toBe(
      'first use: 202'
    );

    // A second episode, drafted BEFORE the restart, whose ticket is still
    // unused. It is the control: if the restart broke redemption outright, this
    // would fail too and the replay assertion below would mean nothing.
    const fresh = await drafted();

    /**
     * The restart. Dropping the pool and reopening it discards every scrap of
     * connection-local and in-process state this module has — which is what a
     * deploy, an eviction or a failover does. Only what is IN THE TABLE survives,
     * and that is the claim.
     */
    await disconnectDb();
    await connectDb();

    expect(`replay after restart: ${(await ingest(d.episodeId, d.ingestTicket)).status}`).toBe(
      'replay after restart: 409'
    );
    expect(`fresh after restart: ${(await ingest(fresh.episodeId, fresh.ingestTicket)).status}`).toBe(
      'fresh after restart: 202'
    );
  });

  it('a ticket for an episode that is already READY', async () => {
    const d = await drafted();

    // Positive control FIRST, on a different episode, so "409" is not just what
    // this endpoint always says.
    const other = await drafted();
    expect(`control: ${(await ingest(other.episodeId, other.ingestTicket)).status}`).toBe(
      'control: 202'
    );

    await getDb()
      .update(episodesTable)
      .set({ status: 'ready' })
      .where(eq(episodesTable.id, d.episodeId));

    expect(`ready: ${(await ingest(d.episodeId, d.ingestTicket)).status}`).toBe('ready: 409');
    // And the ticket was NOT spent on the refusal, so a legitimate retry after
    // the episode is put back is still possible.
    const jti = JSON.parse(atob(d.ingestTicket.split('.')[1])).jti as string;
    expect(`ticket unspent: ${(await readTicket(jti))?.consumedAt}`).toBe('ticket unspent: null');
  });

  it('a ticket for an episode that already carries a MASTER PLAYLIST', async () => {
    /**
     * The second, independent test of the same fact. `status` is a workflow flag
     * several paths write; `hls_master_key` is written by exactly one and only
     * after media really landed. This is the case that still refuses if some
     * future writer moves a finished episode back to `processing`.
     */
    const d = await drafted();
    await getDb()
      .update(episodesTable)
      .set({ status: 'processing', hlsMasterKey: 'hls/already/master.m3u8' })
      .where(eq(episodesTable.id, d.episodeId));

    expect(`has media: ${(await ingest(d.episodeId, d.ingestTicket)).status}`).toBe(
      'has media: 409'
    );
  });

  it('a ticket whose show has since CHANGED HANDS', async () => {
    const d = await drafted();

    await getDb()
      .update(podcasts)
      .set({ ownerOxyUserId: STRANGER })
      .where(eq(podcasts.ownerOxyUserId, OWNER));

    // The signed owner records who was entitled at mint time; the show says who
    // is entitled now. Both have to agree, so the ticket dies with the transfer.
    expect(`after transfer: ${(await ingest(d.episodeId, d.ingestTicket)).status}`).toBe(
      'after transfer: 404'
    );
    expect(`no upload: ${storedKeys.length}`).toBe('no upload: 0');
  });

  it('a ticket whose EPISODE is gone — the row cascades away with it', async () => {
    const d = await drafted();
    await getDb().delete(episodesTable).where(eq(episodesTable.id, d.episodeId));

    expect(`deleted: ${(await ingest(d.episodeId, d.ingestTicket)).status}`).toBe('deleted: 404');
    // The FK cascade took the redemption record with the episode, so even the
    // claim has nothing to find.
    const tickets = await getDb().select().from(episodeIngestTickets);
    expect(`tickets remaining: ${tickets.length}`).toBe('tickets remaining: 0');
  });

  it('a request with no audio file', async () => {
    const d = await drafted();
    const response = await fetch(`${baseUrl}/api/podcasts/episodes/${d.episodeId}/ingest`, {
      method: 'POST',
      headers: { [TICKET_HEADER]: d.ingestTicket },
      body: new FormData(),
    });
    expect(`no file: ${response.status}`).toBe('no file: 400');

    // The ticket survives a request that never had a file — a malformed call
    // must not cost a capability.
    const jti = JSON.parse(atob(d.ingestTicket.split('.')[1])).jti as string;
    expect(`ticket unspent: ${(await readTicket(jti))?.consumedAt}`).toBe('ticket unspent: null');
    expect(`retry works: ${(await ingest(d.episodeId, d.ingestTicket)).status}`).toBe(
      'retry works: 202'
    );
  });
});

// ── The field allowlist ───────────────────────────────────────────────────────

describe('a ticket holder can set the audio metadata and NOTHING else', () => {
  it('ignores every field outside the allowlist', async () => {
    /**
     * The capability's real boundary, as a test.
     *
     * One request carrying both halves: the five allowlisted fields AND seven
     * that a worker must never be able to set. The allowlisted ones changing is
     * the positive control — without it, "nothing changed" would also be true of
     * a handler that ignored the whole body.
     */
    const showId = await seedShow();
    const created = await draft(showId, OWNER, {
      title: 'The Title The User Chose',
      episodeType: 'trailer',
      explicit: true,
      aiGenerated: false,
    });
    const d = created.draft;
    if (!d) throw new Error('no draft');

    const before = await readEpisode(d.episodeId);

    const response = await ingest(d.episodeId, d.ingestTicket, {
      // Allowed.
      duration: '99',
      description: 'Set by the worker',
      // Refused: identity, publication and attribution.
      title: 'Hijacked Title',
      episodeType: 'full',
      explicit: 'false',
      aiGenerated: 'true',
      status: 'ready',
      guid: 'hijacked-guid',
      podcastId: uuidv7(),
      hlsMasterKey: 'hls/hijacked/master.m3u8',
      enclosureUrl: 'https://evil.example.invalid/audio.mp3',
    });
    expect(`status: ${response.status}`).toBe('status: 202');

    const after = await readEpisode(d.episodeId);

    // The allowlist took effect.
    expect(`duration: ${after?.duration}`).toBe('duration: 99');
    expect(`description: ${after?.description}`).toBe('description: Set by the worker');

    // And nothing else moved.
    expect(`title: ${after?.title}`).toBe('title: The Title The User Chose');
    expect(`episodeType: ${after?.episodeType}`).toBe('episodeType: trailer');
    expect(`explicit: ${after?.explicit}`).toBe('explicit: true');
    expect(`aiGenerated: ${after?.aiGenerated}`).toBe('aiGenerated: false');
    expect(`guid: ${after?.guid === before?.guid}`).toBe('guid: true');
    expect(`podcastId: ${after?.podcastId === showId}`).toBe('podcastId: true');
    expect(`hlsMasterKey: ${after?.hlsMasterKey}`).toBe('hlsMasterKey: null');
    expect(`enclosureUrl: ${after?.enclosureUrl}`).toBe('enclosureUrl: null');
    // `status` is written by the handler itself, to `processing` — never to the
    // `ready` the request asked for.
    expect(`status: ${after?.status}`).toBe('status: processing');
  });

  it('refuses a malformed number rather than storing a coerced lie', async () => {
    const showId = await seedShow();
    const created = await draft(showId);
    const d = created.draft;
    if (!d) throw new Error('no draft');

    // `Number('abc')` is NaN and `Number('')` is 0 — both would reach an
    // `integer` column as a crash or a wrong answer.
    expect(`nan: ${(await ingest(d.episodeId, d.ingestTicket, { episodeNumber: 'abc' })).status}`).toBe(
      'nan: 400'
    );
    expect(`negative: ${(await ingest(d.episodeId, d.ingestTicket, { season: '-4' })).status}`).toBe(
      'negative: 400'
    );
    // Positive control, same ticket: a real number is accepted, so the two
    // refusals are the validation and not the endpoint.
    expect(`valid: ${(await ingest(d.episodeId, d.ingestTicket, { episodeNumber: '12' })).status}`).toBe(
      'valid: 202'
    );
  });
});
