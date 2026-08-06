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
 * Every controller guards its handlers with `if (!isDatabaseConnected()) 503`,
 * and that function reports MONGOOSE readiness. On a controller whose reads are
 * all drizzle it is the wrong database in both directions: Mongo down and
 * Postgres up answers 503 for an endpoint that would have worked, and Postgres
 * down with Mongo up sails past the guard and throws inside the handler.
 *
 * `tsc` cannot see it and neither can a test suite that opens both databases —
 * which is how it survived: the ported controllers' suites all call `connect()`
 * as well as `connectDb()`. `browse.controller.test.ts` is the first to open
 * Postgres ALONE, and every one of its handlers answered 503.
 *
 * Only for a controller that has NO Mongoose reads left. A hybrid one still
 * needs Mongo and must keep asking about it — the two questions are different,
 * and a controller reading both stores has to answer both.
 */
export function isPostgresConnected(): boolean {
  return handle !== null;
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
