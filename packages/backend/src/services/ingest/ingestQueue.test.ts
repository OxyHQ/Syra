import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { catalogEntities, tracks } from '../../db/schema/catalog';
import { enqueueIngest, startIngestWorker, stopIngestQueue } from './ingestQueue';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(async () => {
  await stopIngestQueue();
  await disconnectDb();
});

/**
 * These tests cover the no-Redis path only, which is the configuration they run
 * in. Asserted rather than assumed: with REDIS_URL set the enqueue would go to
 * BullMQ and "the job never ran in-process" would be the correct outcome, so a
 * silent skip would turn this file into a check that cannot fail.
 */
const REDIS_CONFIGURED = Boolean(
  (process.env.REDIS_URL ?? process.env.REDIS_URI ?? '').trim(),
);

/**
 * A failed lookup on a live connection settles in single-digit milliseconds;
 * this is an order of magnitude of headroom, not a tuned value.
 */
const BACKGROUND_RUN_SETTLE_MS = 200;

/**
 * Ceiling for the no-Redis decision path.
 *
 * The point of the budget, not the number: absence of Redis is decided from
 * CONFIGURATION (`getRedisUrl()` returns undefined, so no client is ever
 * constructed), never by attempting a connection and waiting for it to fail. If
 * that ever regresses to a connect attempt, every upload in a Redis outage pays
 * a multi-second stall before ingest starts — and a test that only asserts "it
 * eventually fell back" cannot tell the two apart. 500ms is far below any
 * plausible connect timeout and far above a config read.
 */
const FALLBACK_DECISION_BUDGET_MS = 500;

function settleBackgroundRun(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, BACKGROUND_RUN_SETTLE_MS));
}

/** Run `work`, returning how long it took in milliseconds. */
async function elapsed(work: () => Promise<void>): Promise<number> {
  const started = Date.now();
  await work();
  return Date.now() - started;
}

/** A track with no `audioSource`, so ingest fails fast without S3 or ffmpeg. */
async function createProcessingTrack() {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: 'Fallback Artist',
      nameKey: `fallback-${suffix}`,
      source: 'upload',
    })
    .returning({ id: catalogEntities.id });

  const [track] = await getDb().insert(tracks).values({
    title: 'Fallback Track',
    artistId: artist?.id ?? '',
    artistName: 'Test Artist',
    duration: 180,
    source: 'upload',
    status: 'processing',
    isExplicit: false,
    isAvailable: true,
  }).returning({ id: tracks.id });

  if (!track) throw new Error('createProcessingTrack: insert returned no row');
  return track;
}

async function waitForStatus(trackId: string, status: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let current = '';
  while (Date.now() < deadline) {
    const [track] = await getDb().select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
    current = track?.status ?? '';
    if (current === status) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return current;
}

describe('ingest queue', () => {
  it('runs in the no-Redis configuration these tests assume', () => {
    expect(REDIS_CONFIGURED).toBe(false);
  });

  it('starting the worker without Redis is a no-op and does not open a connection', () => {
    // A worker constructed here would hold an open Redis connection and hang the
    // test run at exit, so "the suite terminates" is part of this assertion.
    expect(() => startIngestWorker()).not.toThrow();
    expect(() => startIngestWorker()).not.toThrow();
  });

  it('falls back to running the job in-process when Redis is absent, without stalling the caller', async () => {
    // No audioSource: ingestTrack fails immediately without touching S3 or
    // ffmpeg, and records `failed`. That transition is only reachable by the job
    // actually running — a dropped job leaves the track at `processing`.
    const track = await createProcessingTrack();
    const trackId = track.id;

    // The caller's own wait. In production this sits inside the upload request
    // before its 201, so it must be a config read, not a connection attempt.
    const enqueueMs = await elapsed(() => enqueueIngest(trackId));
    expect(enqueueMs).toBeLessThan(FALLBACK_DECISION_BUDGET_MS);

    expect(await waitForStatus(trackId, 'failed')).toBe('failed');
  });

  it('decides "no Redis" from configuration, not from a failed connection attempt', async () => {
    // Ten enqueues back to back. A per-call connect attempt would compound into
    // seconds here even if one call alone slipped under the budget — which is the
    // production shape that matters: uploads serialising behind repeated timeouts.
    const processing = await Promise.all(Array.from({ length: 10 }, () => createProcessingTrack()));

    const totalMs = await elapsed(async () => {
      for (const track of processing) {
        await enqueueIngest(track.id);
      }
    });

    expect(totalMs).toBeLessThan(FALLBACK_DECISION_BUDGET_MS);
    await settleBackgroundRun();
  });

  it('never rejects, even for a track id that does not exist', async () => {
    // The caller responds 201 after awaiting this; a rejection here would turn a
    // successful upload into a 500.
    await expect(enqueueIngest('507f1f77bcf86cd799439099')).resolves.toBeUndefined();

    // enqueueIngest returns while the fallback run is still in flight. Let that
    // lookup finish before `afterEach` drops the collections out from under it,
    // otherwise the teardown occasionally contends with it and times out.
    await settleBackgroundRun();
  });
});
