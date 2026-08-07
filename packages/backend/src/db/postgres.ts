/**
 * PostgreSQL Connection
 *
 * Drizzle ORM over postgres.js (`drizzle-orm/postgres-js`), built through
 * `@oxyhq/db`'s `createDatabase()` rather than calling `drizzle()` directly —
 * that is what guarantees this handle is built with `DATABASE_CASING`, so the
 * SQL queries reference matches the SQL `drizzle-kit` (via `drizzle.config.ts`)
 * generated. Two independently-derived casings would mean queries reference
 * columns the migrations never created.
 *
 * Connect once at boot, then read the handle synchronously from anywhere via
 * `getDb()`. `server.ts`'s `bootServer` opens it alongside the Mongo
 * connection, with the same log-and-continue failure semantics: a service whose
 * routes are still mostly on Mongoose must not fail to boot because
 * `DATABASE_URL` is unset. Routes that have been ported fail on their own until
 * it is reachable, which is the narrower blast radius.
 */

import { createDatabase, type OxyDatabase } from '@oxyhq/db';
import { logger } from '../utils/logger';
import * as schema from './schema';

/** Seconds `closePostgres` waits for in-flight queries before forcing the socket shut. */
const CLOSE_TIMEOUT_SECONDS = 5;

let handle: { db: OxyDatabase<typeof schema>; client: ReturnType<typeof createDatabase>['client'] } | null = null;

/**
 * Open the connection pool. Call once during startup, before serving traffic.
 *
 * Idempotent: a second call returns the existing handle rather than opening a
 * second pool.
 *
 * @throws {Error} When `DATABASE_URL` is unset, or the opening round trip
 *   fails. This is a REPORTING contract, not a fail-fast one: the throw names
 *   the misconfiguration precisely, and the caller decides what it costs.
 *   `server.ts`'s `bootServer` catches it, logs, and continues — deliberately,
 *   because most routes are still on Mongoose and a service that refuses to
 *   boot without `DATABASE_URL` would take them down too. A script or a test
 *   that needs the connection lets it propagate instead.
 */
export async function connectPostgres(): Promise<OxyDatabase<typeof schema>> {
  if (handle) return handle.db;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Start a local Postgres with: ' +
      'docker compose -f docker-compose.postgres.yml up -d postgres'
    );
  }

  const created = createDatabase({ databaseUrl: url, schema });

  // postgres.js connects lazily, so constructing the pool proves nothing. Issue
  // a real round trip here so an unreachable/misconfigured database fails
  // during startup instead of on the first request — and only publish the
  // handle once that round trip succeeded.
  try {
    await created.client`select 1`;
  } catch (error) {
    await created.client.end({ timeout: CLOSE_TIMEOUT_SECONDS });
    throw error;
  }

  handle = created;
  logger.info('[db] Connected to PostgreSQL successfully');
  return handle.db;
}

/**
 * The connection opened by `connectPostgres()`.
 *
 * @throws {Error} If called before `connectPostgres()` resolved — a
 *   programming error (a query issued before startup finished), not a runtime
 *   condition to recover from.
 */
export function getDb(): OxyDatabase<typeof schema> {
  if (!handle) throw new Error('getDb() called before connectPostgres().');
  return handle.db;
}

/**
 * Whether the pool is open — the Postgres counterpart of
 * `utils/database.ts`'s `isDatabaseConnected()`.
 *
 * **Every connectivity gate in the tree now calls THIS**, and none calls
 * `isDatabaseConnected()`. That sentence used to read the other way round:
 * controllers guarded on Mongoose readiness while their reads were all drizzle,
 * which is the wrong database in both directions — Mongo down and Postgres up
 * answered 503 for an endpoint that would have worked, and Postgres down with
 * Mongo up sailed past the guard and threw inside the handler.
 *
 * It is also the quietest thing that can break at Task 19: `readyState` never
 * reaches 1 once Mongo is removed, so a surviving Mongo gate would 503 its
 * routes permanently, with no error anywhere.
 *
 * `tsc` cannot see any of this, and neither can a suite that opens both
 * databases — which is how it survived six verticals: the ported controllers'
 * suites all called `connect()` as well as `connectDb()`.
 * `db/__tests__/connectivityGates.test.ts` is the standing check now. It walks
 * each gated entry point's whole import graph and fails if anything it reaches
 * opens a Mongoose model, so a gate cannot become wrong again without saying so.
 *
 * The rule it encodes is unchanged: this function is right only where there are
 * NO Mongoose reads left. A genuinely hybrid handler has to ask both questions,
 * because they are different questions.
 */
export function isPostgresConnected(): boolean {
  return handle !== null;
}

/**
 * Fields that make an error unloggable: the statement, its bound values, and
 * Postgres's own `detail`, which reads `Failing row contains (…)`.
 */
const STATEMENT_PAYLOAD_FIELDS = ['query', 'params', 'detail'] as const;

/** Bounded like `@oxyhq/db`'s own walk — a cyclic chain must not hang a `catch`. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Did this error come from the DATABASE, and does it therefore carry data?
 *
 * **Use this, not `sqlStateOf(err) !== undefined`, to decide whether to redact.**
 * `sqlStateOf` is `error.code` walked through the cause chain, so it is true of
 * anything carrying a string `code` — which is most of Node. Measured against
 * the errors this codebase actually produces:
 *
 * ```
 * fs pipeline ENOENT   code=ENOENT      no statement    <- NOT the database
 * s3-style NoSuchKey   code=NoSuchKey   no statement    <- NOT the database
 * EPIPE                code=EPIPE       no statement    <- NOT the database
 * getDb() before connect   code=undefined   no statement
 * drizzle 22003        code=22003       Error[query+params] -> PostgresError[query]
 * drizzle 23503        code=23503       Error[query+params] -> PostgresError[query+detail]
 * ```
 *
 * A `code`-presence test sends the first three down the redacting branch, where
 * `describeDriverError` discards the message — so a full disk (`ENOSPC`) or a
 * missing S3 object gets logged as a database failure with its actual reason
 * thrown away. That is worse than logging nothing: it names the wrong subsystem
 * confidently, and whoever reads it goes to Postgres while the disk is full.
 *
 * Nor is the code's SHAPE a safe test. A SQLSTATE is five characters of
 * `[0-9A-Z]`, and `EPIPE` matches that exactly — a plausible failure of a
 * `pipeline()` into a file, which is precisely where this is used.
 *
 * So the test is the PAYLOAD, which is also the reason redaction exists at all:
 * an error carrying a statement, its bound parameters, or a failing row is one
 * whose message must not be logged. Anything else keeps its message, because
 * that message is the only thing worth having.
 */
export function isDriverError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < MAX_CAUSE_DEPTH; depth += 1) {
    for (const field of STATEMENT_PAYLOAD_FIELDS) {
      if (Reflect.get(current, field) !== undefined) return true;
    }
    current = Reflect.get(current, 'cause');
  }
  return false;
}

/**
 * The raw postgres.js client behind {@link getDb}.
 *
 * Exported for the ONE thing drizzle has no API for: reserving a dedicated
 * connection (`client.reserve()`) so a SESSION-scoped advisory lock can be
 * taken and released on the same backend. Every ordinary query must go through
 * `getDb()` — this is not a general escape hatch, and there is deliberately no
 * helper wrapping it.
 *
 * @throws {Error} When the pool has not been opened, for the same reason
 *   `getDb()` does.
 */
export function getPostgresClient(): ReturnType<typeof createDatabase>['client'] {
  if (!handle) {
    throw new Error('getPostgresClient() called before connectPostgres()');
  }
  return handle.client;
}

/** The handle `getDb()` returns. */
export type Db = OxyDatabase<typeof schema>;

/**
 * The handle a `db.transaction(async (tx) => …)` callback receives.
 *
 * Derived from `Db` rather than written out as `PgTransaction<…>` with its four
 * type arguments: those arguments are drizzle's, and spelling them here would
 * be a second declaration of the same thing that a drizzle upgrade could put
 * out of step with the first.
 */
export type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Either handle, for a function that must be usable inside a caller's
 * transaction AND on its own.
 *
 * The distinction matters: a write that has to commit together with the
 * caller's other writes takes this and is passed the `tx`, while one that calls
 * `getDb()` itself would silently run OUTSIDE the transaction and survive its
 * rollback.
 */
export type DbOrTransaction = Db | DbTransaction;

/** Close the pool (for shutdown hooks). Safe to call when never connected. */
export async function closePostgres(): Promise<void> {
  if (!handle) return;
  const current = handle;
  handle = null;
  await current.client.end({ timeout: CLOSE_TIMEOUT_SECONDS });
}
