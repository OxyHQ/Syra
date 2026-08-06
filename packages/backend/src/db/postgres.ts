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
 * `getDb()`. Nothing calls `connectPostgres()` yet — Mongoose is still this
 * backend's only wired-up store — so this module has no caller until a later
 * task adds one.
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
 * @throws {Error} When `DATABASE_URL` is unset — a startup misconfiguration;
 *   fail fast and loudly rather than degrade, the same contract
 *   `utils/database.ts` already holds for `MONGODB_URI`.
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

/** Close the pool (for shutdown hooks). Safe to call when never connected. */
export async function closePostgres(): Promise<void> {
  if (!handle) return;
  const current = handle;
  handle = null;
  await current.client.end({ timeout: CLOSE_TIMEOUT_SECONDS });
}
