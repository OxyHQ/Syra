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
 * `getDb()`. `server.ts`'s `bootServer` opens it log-and-continue: an
 * unreachable database degrades to a 503 per request rather than taking the
 * whole service down. That is the right trade for a database that is momentarily
 * down and the wrong one for a database that was never configured, which is why
 * `config/env.ts` refuses to boot production when `DATABASE_URL` is unset or is
 * not a `postgres://` URL — the misconfiguration fails loudly at boot, the
 * outage degrades.
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
 * Reads `process.env.DATABASE_URL` LIVE rather than `config/env.ts`'s parsed
 * `env`, and must keep doing so: `env` is parsed once at import, while the test
 * harness (`src/test/postgres.ts`) resolves `TEST_DATABASE_URL` and assigns
 * `process.env.DATABASE_URL` in `beforeAll` — after that parse. Reading the
 * frozen value would send the suite at whatever the developer's own
 * `DATABASE_URL` names. `env.ts` declares the variable as a boot-time GATE, not
 * as the accessor.
 *
 * @throws {Error} When `DATABASE_URL` is unset, or the opening round trip
 *   fails. This is a REPORTING contract, not a fail-fast one: the throw names
 *   the misconfiguration precisely, and the caller decides what it costs.
 *   `server.ts`'s `bootServer` catches it, logs, and continues — deliberately,
 *   so an unreachable database costs a 503 per request instead of the whole
 *   service. A script or a test that needs the connection lets it propagate
 *   instead. In production an unset `DATABASE_URL` never reaches here at all:
 *   `config/env.ts` refuses the boot first.
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
 * Whether the pool is open. **The only connectivity question left**, and every
 * gate in the tree asks it.
 *
 * It is worth knowing why this is emphatic for a function this small. Gates here
 * used to call `utils/database.ts`'s `isDatabaseConnected()` — Mongoose
 * readiness — while the reads underneath them were all drizzle, which is the
 * wrong database in both directions: Mongo down and Postgres up answered 503 for
 * an endpoint that would have worked, and Postgres down with Mongo up sailed
 * past the guard and threw inside the handler. `tsc` could not see it, and
 * neither could a suite that opened both databases, which is how it survived six
 * verticals.
 *
 * That whole class of bug is now closed by construction rather than by a check:
 * Mongoose, `utils/database.ts` and the last four models are gone, so there is
 * no second readiness flag left to ask the wrong one of. The scanner that
 * policed it (`db/__tests__/connectivityGates.test.ts`, which walked each gated
 * entry point's import graph looking for a Mongoose model) was retired with its
 * subject — a gate whose violation is now unrepresentable is a gate that can
 * only ever pass.
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
