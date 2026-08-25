/**
 * Three things the ingest task fixed or added that are not the capability:
 * the metadata `uploadEpisode` was DROPPING, the order a numbered series comes
 * back in, and the provenance/disclosure pair.
 *
 * All three are driven over the real routers rather than against the DB helpers,
 * because all three were invisible precisely at that layer: the fields were
 * parsed out of a multipart body and thrown away, the ordering is decided by the
 * listing endpoint, and the provenance row is written by a create handler.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { asc, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import {
  episodes as episodesTable,
  podcastSources,
  podcasts,
} from '../db/schema/podcasts';
import * as realS3 from '../services/s3Service';
import * as realIngest from '../services/podcasts/ingestEpisode';
import podcastsRoutes from './podcasts.routes';

/**
 * The real implementations, captured BY VALUE before the mocks are registered.
 *
 * `import * as realIngest` is a LIVE binding: once `mock.module` replaces the
 * module, reading `realIngest.enqueueEpisodeIngest` returns THE FAKE, so a fake
 * that "delegates to the real one" re-enters itself. Measured — a full-suite run
 * produced a wall of `at enqueueEpisodeIngest (…test.ts)` frames and failed
 * `ingestEpisode.test.ts`, two directories away, with a stack overflow.
 *
 * Copying each function into a `const` at module-init time — before the
 * `mock.module` calls below, which run after the imports are evaluated — freezes
 * the reference. A local `const` is the one thing the module registry cannot
 * rewrite.
 */
const realUploadToS3 = realS3.uploadToS3;
const realEnqueueEpisodeIngest = realIngest.enqueueEpisodeIngest;

/**
 * Both fakes are ARMED only while this file's tests run.
 *
 * `mock.module` is process-global, so a fake left live would hand every later
 * file in the run a working S3 and a no-op transcode queue — and
 * `services/podcasts/ingestEpisode.test.ts` tests the real
 * `enqueueEpisodeIngest`. The sibling ingest suite scopes its fakes by episode
 * id, which it can do because it learns every id from a draft RESPONSE; here the
 * id is minted inside the handler under test, so there is nothing to register in
 * advance. A flag set in `beforeAll` and cleared in `afterAll` is the honest
 * scope: while this suite runs, the fake answers; afterwards it delegates.
 */
let armed = false;

mock.module('../services/s3Service', () => ({
  ...realS3,
  uploadToS3: async (key: string, body: unknown, options?: unknown) => {
    if (!armed) {
      return realUploadToS3(
        key,
        body as Parameters<typeof realS3.uploadToS3>[1],
        options as Parameters<typeof realS3.uploadToS3>[2]
      );
    }
  },
}));

mock.module('../services/podcasts/ingestEpisode', () => ({
  ...realIngest,
  enqueueEpisodeIngest: (episodeId: string) => {
    if (!armed) realEnqueueEpisodeIngest(episodeId);
  },
}));

const OWNER = 'oxy-metadata-owner';
const VIEWER_HEADER = 'x-test-viewer';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  armed = true;
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
});

afterAll(async () => {
  armed = false;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectDb();
});

async function seedShow(): Promise<string> {
  const id = uuidv7();
  await getDb().insert(podcasts).values({
    id,
    title: 'Metadata Show',
    source: 'syra',
    status: 'active',
    ownerOxyUserId: OWNER,
    feedUrl: `https://feeds.example.invalid/${id}.xml`,
  });
  return id;
}

/** `POST /api/podcasts/:id/episodes` with a real multipart body, as Studio sends it. */
async function uploadEpisode(
  showId: string,
  fields: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  const form = new FormData();
  form.append(
    'audioFile',
    new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' }),
    'episode.mp3'
  );
  for (const [key, value] of Object.entries(fields)) form.append(key, value);

  const response = await fetch(`${baseUrl}/api/podcasts/${showId}/episodes`, {
    method: 'POST',
    headers: { [VIEWER_HEADER]: OWNER },
    body: form,
  });
  return { status: response.status, body: await response.json() };
}

// ── The dropped fields ────────────────────────────────────────────────────────

describe('POST /api/podcasts/:id/episodes honours the metadata Studio sends', () => {
  it('stores season, episodeNumber and episodeType', async () => {
    /**
     * All three were SILENTLY DROPPED: the handler read neither `season` nor
     * `episodeNumber` and hardcoded `episodeType: 'full'`, while
     * `packages/studio/services/episodeService.ts` had been sending all three
     * since it was written. A creator numbering a serial show watched every
     * episode come back unnumbered with no error anywhere.
     *
     * Asserted on the STORED row, not the response, so a serializer that echoed
     * the request back could not satisfy it.
     */
    const showId = await seedShow();
    const created = await uploadEpisode(showId, {
      title: 'Numbered',
      season: '4',
      episodeNumber: '17',
      episodeType: 'trailer',
      duration: '600',
    });

    expect(`upload: ${created.status}`).toBe('upload: 201');

    const [episode] = await getDb().select().from(episodesTable);
    expect(`season: ${episode?.season}`).toBe('season: 4');
    expect(`episodeNumber: ${episode?.episodeNumber}`).toBe('episodeNumber: 17');
    expect(`episodeType: ${episode?.episodeType}`).toBe('episodeType: trailer');
  });

  it('leaves them ABSENT when the client sends nothing, rather than storing 0', async () => {
    /**
     * The other half, and the reason the fields are validated rather than
     * coerced: `Number(undefined)` is NaN and `Number('')` is 0, so a naive
     * `Number(req.body.season)` would file every unnumbered episode as season 0 —
     * a wrong answer that looks like data.
     */
    const showId = await seedShow();
    expect(`upload: ${(await uploadEpisode(showId, { title: 'Plain' })).status}`).toBe(
      'upload: 201'
    );

    const [episode] = await getDb().select().from(episodesTable);
    expect(`season: ${episode?.season}`).toBe('season: null');
    expect(`episodeNumber: ${episode?.episodeNumber}`).toBe('episodeNumber: null');
    // The default the handler used to hardcode is still the default — it is just
    // no longer the only possibility.
    expect(`episodeType: ${episode?.episodeType}`).toBe('episodeType: full');
  });

  it('rejects a malformed number instead of storing a coerced lie', async () => {
    const showId = await seedShow();
    expect(
      `nan: ${(await uploadEpisode(showId, { title: 'X', episodeNumber: 'abc' })).status}`
    ).toBe('nan: 400');
    expect(`negative: ${(await uploadEpisode(showId, { title: 'X', season: '-1' })).status}`).toBe(
      'negative: 400'
    );
    expect(
      `bad enum: ${(await uploadEpisode(showId, { title: 'X', episodeType: 'movie' })).status}`
    ).toBe('bad enum: 400');
    // Positive control: the same shape with valid values is accepted, so the
    // three refusals are the validation and not the endpoint.
    expect(
      `valid: ${(await uploadEpisode(showId, { title: 'X', episodeNumber: '3', season: '1', episodeType: 'bonus' })).status}`
    ).toBe('valid: 201');
  });
});

// ── The ordering ──────────────────────────────────────────────────────────────

describe('GET /api/podcasts/:id/episodes orders a numbered series by NUMBER', () => {
  /**
   * The fixture is the whole test: `episode_number` and `pub_date` are in
   * OPPOSITE orders, so the two orderings disagree on every pair. A fixture where
   * they agreed — the natural one to write — would pass against both the old
   * ordering and the new one and prove nothing.
   *
   * Episode 1 is published most recently, episode 4 oldest.
   */
  async function seedNumbered(showId: string): Promise<void> {
    await getDb()
      .insert(episodesTable)
      .values(
        [1, 2, 3, 4].map((n) => ({
          id: uuidv7(),
          podcastId: showId,
          podcastTitle: 'Metadata Show',
          title: `Episode ${n}`,
          guid: `guid-${n}`,
          // Descending date as the number ASCENDS.
          pubDate: new Date(Date.UTC(2026, 0, 10 - n)),
          source: 'syra' as const,
          status: 'ready' as const,
          episodeNumber: n,
        }))
      );
  }

  async function listedTitles(showId: string): Promise<string[]> {
    const response = await fetch(`${baseUrl}/api/podcasts/${showId}/episodes`);
    expect(`list: ${response.status}`).toBe('list: 200');
    const body = (await response.json()) as { data: { title: string }[] };
    return body.data.map((episode) => episode.title);
  }

  it('returns the highest episode number first, not the newest date', async () => {
    const showId = await seedShow();
    await seedNumbered(showId);

    // By number descending. By DATE descending this would be 1, 2, 3, 4 — the
    // exact reverse — which is what makes this a measurement.
    expect(await listedTitles(showId)).toEqual([
      'Episode 4',
      'Episode 3',
      'Episode 2',
      'Episode 1',
    ]);
  });

  it('puts UNNUMBERED episodes last, then orders them among themselves by date', async () => {
    /**
     * `NULLS LAST` is what keeps the change safe for shows that do not number.
     * A show mixing both is the only case that can tell `NULLS LAST` from
     * `NULLS FIRST`, and it is not hypothetical: a series that starts numbering
     * halfway through is exactly this shape.
     */
    const showId = await seedShow();
    await seedNumbered(showId);
    await getDb()
      .insert(episodesTable)
      .values(
        ['Older Extra', 'Newer Extra'].map((title, index) => ({
          id: uuidv7(),
          podcastId: showId,
          podcastTitle: 'Metadata Show',
          title,
          guid: `guid-extra-${index}`,
          pubDate: new Date(Date.UTC(2025, 0, 1 + index)),
          source: 'syra' as const,
          status: 'ready' as const,
        }))
      );

    expect(await listedTitles(showId)).toEqual([
      'Episode 4',
      'Episode 3',
      'Episode 2',
      'Episode 1',
      // Both unnumbered, newest of the two first.
      'Newer Extra',
      'Older Extra',
    ]);
  });

  it('is unchanged for a show that numbers NOTHING', async () => {
    // The compatibility half: with no numbers at all the ordering is
    // byte-for-byte what it was before the change.
    const showId = await seedShow();
    await getDb()
      .insert(episodesTable)
      .values(
        [1, 2, 3].map((n) => ({
          id: uuidv7(),
          podcastId: showId,
          podcastTitle: 'Metadata Show',
          title: `Undated ${n}`,
          guid: `guid-u-${n}`,
          pubDate: new Date(Date.UTC(2026, 0, n)),
          source: 'syra' as const,
          status: 'ready' as const,
        }))
      );

    expect(await listedTitles(showId)).toEqual(['Undated 3', 'Undated 2', 'Undated 1']);
  });
});

// ── Provenance and disclosure ─────────────────────────────────────────────────

describe('POST /api/podcasts records Alia provenance and the AI flag', () => {
  async function createShow(body: Record<string, unknown>): Promise<{ status: number; id?: string }> {
    const response = await fetch(`${baseUrl}/api/podcasts`, {
      method: 'POST',
      headers: { [VIEWER_HEADER]: OWNER, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status !== 201) return { status: response.status };
    const payload = (await response.json()) as { data: { id: string } };
    return { status: response.status, id: payload.data.id };
  }

  it('writes a provider=alia source row, without touching podcasts.source', async () => {
    /**
     * `podcasts.source` stays `'syra'`, and that is the load-bearing assertion:
     * `source === 'syra'` is the owner-write predicate in five handlers, so a
     * third value there would remove write access from every Alia-authored show.
     * Provenance answers "who made it" on its own table.
     */
    const created = await createShow({
      title: 'Generated Show',
      aliaSeriesId: 'alia-series-42',
      aiGenerated: true,
    });
    expect(`create: ${created.status}`).toBe('create: 201');
    if (!created.id) throw new Error('no id');

    const [show] = await getDb().select().from(podcasts).where(eq(podcasts.id, created.id));
    expect(`source: ${show?.source}`).toBe('source: syra');
    expect(`aiGenerated: ${show?.aiGenerated}`).toBe('aiGenerated: true');

    const sources = await getDb()
      .select()
      .from(podcastSources)
      .where(eq(podcastSources.podcastId, created.id))
      .orderBy(asc(podcastSources.position));
    expect(`rows: ${sources.length}`).toBe('rows: 1');
    expect(`provider: ${sources[0]?.provider}`).toBe('provider: alia');
    expect(`externalId: ${sources[0]?.externalId}`).toBe('externalId: alia-series-42');

    // And the show still edits, which is the thing a `source` change would have
    // broken. PATCH is the cheapest proof that the owner-write predicate holds.
    const patched = await fetch(`${baseUrl}/api/podcasts/${created.id}`, {
      method: 'PATCH',
      headers: { [VIEWER_HEADER]: OWNER, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed' }),
    });
    expect(`still editable: ${patched.status}`).toBe('still editable: 200');
  });

  it('treats provenance and the AI flag as INDEPENDENT', async () => {
    /**
     * Neither implies the other, so neither is derived from the other: a person
     * can host a show published through Alia, and a machine-generated show can
     * arrive from somewhere else entirely. Both one-sided cases are asserted,
     * because a handler that derived one from the other would satisfy the
     * both-set case above perfectly.
     */
    const aliaOnly = await createShow({ title: 'Human Host', aliaSeriesId: 'alia-series-7' });
    if (!aliaOnly.id) throw new Error('no id');
    const [humanShow] = await getDb().select().from(podcasts).where(eq(podcasts.id, aliaOnly.id));
    expect(`alia but not ai: ${humanShow?.aiGenerated}`).toBe('alia but not ai: false');
    expect(
      `alia row present: ${(await getDb().select().from(podcastSources).where(eq(podcastSources.podcastId, aliaOnly.id))).length}`
    ).toBe('alia row present: 1');

    const aiOnly = await createShow({ title: 'Generated Elsewhere', aiGenerated: true });
    if (!aiOnly.id) throw new Error('no id');
    const [aiShow] = await getDb().select().from(podcasts).where(eq(podcasts.id, aiOnly.id));
    expect(`ai but no provenance: ${aiShow?.aiGenerated}`).toBe('ai but no provenance: true');
    expect(
      `no source row: ${(await getDb().select().from(podcastSources).where(eq(podcastSources.podcastId, aiOnly.id))).length}`
    ).toBe('no source row: 0');
  });

  it('defaults both to absent for an ordinary show', async () => {
    const created = await createShow({ title: 'Ordinary' });
    if (!created.id) throw new Error('no id');

    const [show] = await getDb().select().from(podcasts).where(eq(podcasts.id, created.id));
    expect(`aiGenerated: ${show?.aiGenerated}`).toBe('aiGenerated: false');
    expect(
      `sources: ${(await getDb().select().from(podcastSources).where(eq(podcastSources.podcastId, created.id))).length}`
    ).toBe('sources: 0');
  });

  it('serializes aiGenerated to EVERY viewer, owner and stranger alike', async () => {
    /**
     * A disclosure is for the person who is NOT the owner, so it is deliberately
     * outside the owner-only set that hides `etag` and `feedUrl`. Both viewers
     * asserted, because "the owner sees it" would also be true of a field that
     * was owner-only.
     */
    const created = await createShow({ title: 'Disclosed', aiGenerated: true });
    if (!created.id) throw new Error('no id');

    for (const viewer of [OWNER, 'oxy-someone-else', undefined]) {
      const response = await fetch(`${baseUrl}/api/podcasts/${created.id}`, {
        headers: viewer === undefined ? {} : { [VIEWER_HEADER]: viewer },
      });
      const body = (await response.json()) as { data: { podcast: Record<string, unknown> } };
      expect(`${viewer ?? 'anonymous'}: ${body.data.podcast.aiGenerated}`).toBe(
        `${viewer ?? 'anonymous'}: true`
      );
    }
  });
});
