/**
 * Durable delivery for the HLS ingest job.
 *
 * Ingest used to be fire-and-forget in-process: an ECS task restart (deploy,
 * scale-in, OOM) stranded the track in `status: 'processing'` forever with
 * nothing left to retry it. At creator volume that is rare enough to ignore; at
 * consumer-upload volume it is a steady leak of dead rows.
 *
 * Jobs now go to a BullMQ queue on `REDIS_URL`, so a restart re-delivers them and
 * a transient ffmpeg/S3 failure is retried with backoff. `REDIS_URL` is optional
 * (local dev, tests, any deploy without ElastiCache): when it is absent no queue
 * is constructed and the job runs in-process exactly as before — degraded, not
 * broken.
 *
 * ONE queue, ONE connection, ONE worker for every kind of job — see
 * `IngestJobKind` for how to add another without a second of any of them.
 *
 * House constraints this file exists to satisfy (see ~/Oxy/AGENTS.md):
 *  - queue names must not contain `:` → `syra-ingest`
 *  - custom job ids must not contain `:` → `<kind>-<ObjectId hex>`, neither half
 *    of which can contain one
 *  - `maxRetriesPerRequest: null`, or BullMQ's blocking BZPOPMIN gives up
 *  - the `connection` is a plain options object, never a shared client instance
 */

import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions, Job } from 'bullmq';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { ingestTrack } from './ingestTrack';
import type { IngestOptions } from './ingestTrack';
import { ingestUserUpload } from './ingestUserUpload';
import { enrichArtistProfile } from '../uploads/enrichCatalogEntity';
import { describeErrorSafely } from '../../utils/error';

/** BullMQ rejects `:` in queue names — it is its own key separator. */
const INGEST_QUEUE_NAME = 'syra-ingest';

/**
 * One transcode at a time per instance. ffmpeg already saturates the available
 * cores on a single rendition, so a second concurrent job would only trade
 * throughput for latency on both.
 */
const INGEST_CONCURRENCY = 1;

/** Three attempts over ~15 minutes covers a transient S3/ffmpeg failure. */
const INGEST_ATTEMPTS = 3;
const INGEST_BACKOFF_DELAY_MS = 30_000;

/**
 * How long an enqueue may block the HTTP request that triggered it.
 *
 * `maxRetriesPerRequest: null` is mandatory for the worker's blocking BZPOPMIN,
 * but it also means a command issued while Redis is unreachable is retried
 * forever rather than rejecting — an unbounded `add` would hold the upload
 * response open until the load balancer gave up. Past this bound the caller
 * stops waiting and ingests in-process instead. If the queued job is later
 * delivered anyway the track is simply ingested twice, which `storePackagedHls`
 * already makes idempotent (fixed S3 keys, TrackKey upsert).
 */
const ENQUEUE_TIMEOUT_MS = 5_000;

/**
 * Which kind of work a job is, and therefore which id space `recordId` is drawn
 * from and which handler runs it.
 *
 * ADDING A THIRD KIND (e.g. background artist enrichment) is deliberately a
 * three-line change and needs no second connection, worker or process:
 *   1. add the literal here,
 *   2. add its handler to `JOB_HANDLERS` below,
 *   3. export a named `enqueue…` wrapper around `deliver`.
 * Keep the wrapper's parameter named for ITS id space. The one bug this shape
 * exists to prevent is an id from one collection travelling in a parameter named
 * for another, which produces a job that runs, succeeds, and writes to the wrong
 * place.
 */
type IngestJobKind = 'track' | 'upload' | 'artist-enrichment';

interface IngestJobData {
  /**
   * The id of the record to process, in the id space `kind` selects — a
   * `Track._id` for 'track', a `UserUpload._id` for 'upload'. Deliberately NOT
   * called `trackId`: it is not always a track.
   */
  recordId: string;
  kind: IngestJobKind;
  /** Rendition ladder for this job; absent means the handler's own default. */
  bitratesKbps?: number[];
}

/**
 * One handler per kind. The worker dispatches through this map, so a locker job
 * can never be picked up by the catalog handler and vice versa.
 */
const JOB_HANDLERS: Record<IngestJobKind, (data: IngestJobData) => Promise<void>> = {
  track: (data) =>
    ingestTrack(
      data.recordId,
      undefined,
      data.bitratesKbps ? { bitratesKbps: data.bitratesKbps } : {},
    ),
  upload: (data) => ingestUserUpload(data.recordId),
  /**
   * Background enrichment of a contributed artist profile. On this queue and not
   * a second one because it has the same shape of need — durable, retryable, and
   * emphatically not inline: Wikidata and Commons are rate limited to about one
   * request a second and no upload may wait behind that.
   */
  'artist-enrichment': async (data) => {
    await enrichArtistProfile(data.recordId);
  },
};

let queue: Queue<IngestJobData> | null = null;
let worker: Worker<IngestJobData> | null = null;

/**
 * The configured Redis URL, or undefined when Redis is not configured.
 *
 * Read from the parsed env rather than `process.env` so the two spellings the
 * deployment uses (`REDIS_URL`, legacy `REDIS_URI`) are resolved in one place,
 * matching how `utils/redis.ts` resolves them for the cache and pub/sub clients.
 */
function getRedisUrl(): string | undefined {
  const url = (env.REDIS_URL ?? env.REDIS_URI)?.trim();
  return url && url.length > 0 ? url : undefined;
}

function buildConnection(url: string): ConnectionOptions {
  return {
    url,
    // BullMQ blocks on BZPOPMIN for up to the block timeout; with a retry cap
    // the client aborts the command and the worker stops consuming.
    maxRetriesPerRequest: null,
  };
}

function getQueue(): Queue<IngestJobData> | null {
  if (queue) return queue;

  const url = getRedisUrl();
  if (!url) return null;

  queue = new Queue<IngestJobData>(INGEST_QUEUE_NAME, { connection: buildConnection(url) });
  queue.on('error', (err) => logger.error('[ingest] queue error', { err: describeErrorSafely(err) }));
  return queue;
}

type EnqueueOutcome = 'enqueued' | 'rejected' | 'timed-out';

/**
 * Resolve `'timed-out'` once `ENQUEUE_TIMEOUT_MS` elapses, so a stalled Redis
 * cannot hold the caller's request open. The losing promise keeps running; the
 * caller simply stops waiting on it.
 */
async function withEnqueueTimeout(added: Promise<EnqueueOutcome>): Promise<EnqueueOutcome> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      added,
      new Promise<EnqueueOutcome>((resolve) => {
        timer = setTimeout(() => resolve('timed-out'), ENQUEUE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runJob(data: IngestJobData): Promise<void> {
  const handler = JOB_HANDLERS[data.kind];
  if (!handler) {
    // Reachable only if a job of a kind this build does not know about is drained
    // from Redis — e.g. a rollback below the deploy that introduced it. Fail the
    // job loudly rather than silently dropping the record.
    throw new Error(`ingestQueue: no handler for job kind "${data.kind}"`);
  }
  await handler(data);
}

/**
 * Start consuming ingest jobs on this instance. Idempotent, and a no-op when
 * Redis is not configured (the enqueue path then runs jobs in-process instead).
 *
 * Called at boot rather than lazily on first enqueue: the instance that accepts
 * an upload is not necessarily the one that should transcode it, and after a
 * restart there may be queued work with no new upload to trigger a lazy start.
 */
export function startIngestWorker(): void {
  if (worker) return;

  const url = getRedisUrl();
  if (!url) {
    logger.info('[ingest] REDIS_URL not set — ingest runs in-process without durable retries');
    return;
  }

  worker = new Worker<IngestJobData>(
    INGEST_QUEUE_NAME,
    async (job: Job<IngestJobData>) => runJob(job.data),
    { connection: buildConnection(url), concurrency: INGEST_CONCURRENCY },
  );

  worker.on('failed', (job, err) => {
    logger.error('[ingest] job failed', {
      kind: job?.data.kind,
      recordId: job?.data.recordId,
      attemptsMade: job?.attemptsMade,
      err: describeErrorSafely(err),
    });
  });
  worker.on('error', (err) => logger.error('[ingest] worker error', { err: describeErrorSafely(err) }));

  // Open the producer connection now too. Constructed lazily it would be the
  // first upload after a deploy that pays for establishing it, and that upload
  // is exactly the one most likely to hit the enqueue timeout.
  getQueue();

  logger.info('[ingest] durable worker started', {
    queue: INGEST_QUEUE_NAME,
    concurrency: INGEST_CONCURRENCY,
  });
}

/**
 * Deliver one job, durably if Redis allows and in-process otherwise.
 *
 * Resolves once the job is recorded in Redis, or — when Redis is absent, refuses
 * the job, or is too slow — once the in-process fallback has been scheduled. It
 * never rejects and never waits for the transcode itself, so a caller can await
 * it before responding without holding the request open for minutes.
 */
async function deliver(data: IngestJobData): Promise<void> {
  const { recordId, kind } = data;

  /**
   * `<kind>-<ObjectId hex>`. Namespacing by kind is required, not decorative: a
   * `Track._id` and a `UserUpload._id` are drawn from the SAME ObjectId space,
   * so a bare id would let a locker job and a catalog job share a job id and
   * dedup each other away. It is also free of the `:` BullMQ rejects in custom
   * job ids by construction, so it needs no hashing to be a legal id.
   */
  const jobId = `${kind}-${recordId}`;

  const activeQueue = getQueue();
  if (activeQueue) {
    // The rejection is folded into the resolved value rather than left as a
    // rejection: past the timeout the caller stops awaiting this promise, and a
    // rejection arriving after that would be an unhandled one.
    const added: Promise<EnqueueOutcome> = activeQueue
      .add(INGEST_QUEUE_NAME, data, {
        // One ingest in flight per record is exactly the dedup we want.
        jobId,
        attempts: INGEST_ATTEMPTS,
        backoff: { type: 'exponential', delay: INGEST_BACKOFF_DELAY_MS },
        // The durable outcome record is the document's own `status`, not a
        // retained job. Removing both terminal states also keeps a re-ingest of
        // the same record from colliding with its own finished job id.
        removeOnComplete: true,
        removeOnFail: true,
      })
      .then(
        (): EnqueueOutcome => 'enqueued',
        (err: unknown): EnqueueOutcome => {
          logger.error('[ingest] enqueue rejected, running in-process instead', { kind, recordId, err: describeErrorSafely(err) });
          return 'rejected';
        },
      );

    const outcome = await withEnqueueTimeout(added);
    if (outcome === 'enqueued') return;
    if (outcome === 'timed-out') {
      logger.warn('[ingest] enqueue did not complete in time, running in-process instead', {
        kind,
        recordId,
        timeoutMs: ENQUEUE_TIMEOUT_MS,
      });
    }
  }

  // Fallback: no Redis, the enqueue was refused, or it took too long. Same
  // behaviour as before the queue existed — `status: 'failed'` records the outcome.
  void runJob(data).catch((err) =>
    logger.error('[ingest] in-process run failed', { kind, recordId, err: describeErrorSafely(err) }),
  );
}

/** Hand a catalog `Track` to HLS ingest. `trackId` is a `Track._id`. */
export function enqueueIngest(trackId: string, options?: IngestOptions): Promise<void> {
  return deliver({
    recordId: trackId,
    kind: 'track',
    ...(options?.bitratesKbps && { bitratesKbps: [...options.bitratesKbps] }),
  });
}

/**
 * Hand a personal-locker `UserUpload` to HLS ingest.
 *
 * The ladder is not a parameter here: locker files are always single-rendition,
 * and letting a caller widen that would reintroduce the transcode cost the
 * separate path exists to avoid.
 */
export function enqueueUploadIngest(uploadId: string): Promise<void> {
  return deliver({ recordId: uploadId, kind: 'upload' });
}

/**
 * Hand a `CatalogEntity` artist to background enrichment. `artistId` is a
 * `CatalogEntity._id`.
 *
 * Enrichment itself refuses any artist without a verified MusicBrainz id, so
 * enqueueing one that turns out not to have it costs a single indexed read and
 * writes nothing — the gate lives with the work, not with the caller.
 */
export function enqueueArtistEnrichment(artistId: string): Promise<void> {
  return deliver({ recordId: artistId, kind: 'artist-enrichment' });
}

/** Release the queue and worker connections (tests, graceful shutdown). */
export async function stopIngestQueue(): Promise<void> {
  const closing: Promise<void>[] = [];
  if (worker) {
    closing.push(worker.close());
    worker = null;
  }
  if (queue) {
    closing.push(queue.close());
    queue = null;
  }
  await Promise.all(closing);
}
