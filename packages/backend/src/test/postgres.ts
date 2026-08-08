/**
 * Real-Postgres test helper for bun test suites — the drizzle counterpart of
 * `test/mongo.ts`.
 *
 * Usage, deliberately the same three hooks the Mongo helper uses so a ported
 * suite reads the same way:
 *
 *   import { connectDb, clearDb, disconnectDb } from '../test/postgres';
 *   beforeAll(connectDb);
 *   afterEach(clearDb);
 *   afterAll(disconnectDb);
 *
 * ## Why a shared database and not one per file
 *
 * `bun test` runs test FILES serially in one process, so a shared database
 * cannot be raced the way a parallel runner would race it. A throwaway database
 * per file (`@oxyhq/db`'s `createTestDatabase`) would re-run all 17 migrations
 * for every suite; against a serial runner that buys isolation nothing needs.
 *
 * ## Why TRUNCATE and not DELETE
 *
 * `clearDb` truncates every table the drizzle barrel exports, in ONE statement
 * with `CASCADE` — order-independent, so it cannot be broken by a foreign key
 * added later, and it cannot leave a table behind because the list is derived
 * from the schema rather than maintained here. `RESTART IDENTITY` is absent on
 * purpose: every id in this schema is a `text` primary key the application
 * mints, so there is no sequence to restart.
 *
 * ## It refuses to run against a database that is not disposable
 *
 * `clearDb` TRUNCATEs every table, so pointing it at a shared database destroys
 * whatever anyone else is holding there. The default `TEST_DATABASE_URL` in a
 * developer's local `.env` points at `syra_dev` — the SHARED dev database — so
 * the only thing standing between a routine `bun test` and wiping a colleague's
 * data was remembering to override it. With several agents working in one
 * worktree that is not a convention worth relying on, so
 * {@link assertDisposableDatabase} makes it a precondition instead: a name that
 * does not declare itself disposable is refused, loudly, before a single row is
 * written or removed.
 *
 * ## The one thing this helper will not do
 *
 * It does not migrate. `TEST_DATABASE_URL` must already point at a migrated
 * database (`bun run db:migrate`), and {@link connectDb} asserts that rather
 * than discovering it as a confusing "relation does not exist" three layers
 * into a test: a suite running against an unmigrated database would otherwise
 * report failures that say nothing about the code under test.
 *
 * Nor does it re-migrate. A per-agent database goes STALE the moment someone
 * else lands a migration, and the failures that produces are named after THEIR
 * code, not yours — five such failures in one run of this suite were a database
 * two migrations behind, not the change that appeared to break it. Re-run
 * `bun run db:migrate` before trusting a red run.
 */

import { isTable, sql } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import * as schema from '../db/schema';

/**
 * A table count below this means the barrel import resolved to nothing useful
 * and `clearDb` would silently truncate an empty list — leaving every suite's
 * rows in place and turning cross-test contamination into the default. Raised
 * whenever the schema grows, exactly like `db/__tests__/gates.test.ts`'s floor.
 */
const MINIMUM_TABLES = 69;

/**
 * Segments that mark a database name as disposable.
 *
 * Matched against `_`-delimited SEGMENTS, never as substrings, and that is the
 * whole reason this is a set of segments rather than a regex over the name:
 * `'ci'` as a substring appears inside `special`, `precision` and `municipal`,
 * so substring matching would silently ALLOW a database nobody meant to expose.
 * A guard that fails open on a name it was never shown is worse than none.
 *
 * `task` is matched with a trailing counter (`task16`, `task13a`) because that
 * is how the agents on this migration name their per-task scratch databases.
 */
const DISPOSABLE_SEGMENTS = new Set(['test', 'tests', 'ci']);
const DISPOSABLE_SEGMENT_PATTERN = /^task[0-9][0-9a-z]*$/;

/**
 * The database a URL names, or `undefined` if it names none.
 *
 * `URL` parses the `postgres://` scheme fine; the pathname is `/<database>`,
 * and a URL with no database at all yields an empty string rather than throwing.
 */
function databaseNameOf(url: string): string | undefined {
  try {
    const name = new URL(url).pathname.replace(/^\//, '');
    return name === '' ? undefined : decodeURIComponent(name);
  } catch {
    return undefined;
  }
}

/** Whether `name` declares itself disposable in one of its `_`-delimited segments. */
function isDisposableName(name: string): boolean {
  return name
    .split('_')
    .some((s) => DISPOSABLE_SEGMENTS.has(s) || DISPOSABLE_SEGMENT_PATTERN.test(s));
}

/**
 * Refuse a database that has not declared itself disposable.
 *
 * Fail CLOSED: an unrecognised name is refused rather than allowed, so a
 * database this rule has never been shown — a colleague's, a staging copy,
 * production — is protected by default instead of by having been listed.
 *
 * The check is on the NAME because that is the one property available before
 * connecting and the one a person can see in the message. It is a guard against
 * an accident, not against a determined caller: anyone may name a database
 * `syra_test` and lose it. That is the intended contract.
 */
export function assertDisposableDatabase(url: string): void {
  const name = databaseNameOf(url);

  if (name === undefined) {
    throw new Error(
      'The test database URL names no database, so it cannot be verified as disposable. ' +
      'Set TEST_DATABASE_URL to a URL ending in /<database>.'
    );
  }

  if (isDisposableName(name)) return;

  throw new Error(
    `Refusing to run the suite against the database "${name}": the suite writes fixtures ` +
    'into it and `clearDb` TRUNCATEs every table, and this name does not declare itself ' +
    'disposable, so it may be a shared database someone else is using.\n' +
    'A disposable database names itself one in an underscore-delimited segment — ' +
    `${[...DISPOSABLE_SEGMENTS].map((s) => `"${s}"`).join(', ')}, or "task<n>" ` +
    '(e.g. syra_test, syra_ci, syra_task16).\n' +
    'Create one and point the suite at it:\n' +
    `  createdb ${name}_test  # or: psql -c 'create database ${name}_test'\n` +
    `  TEST_DATABASE_URL=<same url, ending in /${name}_test> bun run db:migrate --phase=all --target-database=${name}_test\n` +
    `  TEST_DATABASE_URL=<same url, ending in /${name}_test> bun test src`
  );
}

/**
 * The URL the suite runs against.
 *
 * `TEST_DATABASE_URL` wins over `DATABASE_URL` when both are set, so a developer
 * whose `DATABASE_URL` points at something they care about cannot have it
 * truncated by running the suite.
 */
function resolveTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL (or DATABASE_URL) must point at a migrated Postgres.');
  }
  return url;
}

let tableNames: string[] | undefined;

/** Every table the schema barrel exports, quoted for one TRUNCATE statement. */
function quotedTableNames(): string[] {
  if (tableNames) return tableNames;

  // `as unknown[]` before the predicate, exactly as `db/__tests__/gates.test.ts`
  // does and for the reason recorded there: against the heterogeneous barrel
  // union, `(value): value is PgTable` fails TS2677 — `PgTable<TableConfig>` is
  // a strict supertype of each branded table type, so the predicate is not
  // assignable to the parameter's type. Widening the input to `unknown` makes
  // any predicate assignable; the runtime `isTable` brand check is unaffected.
  const names = (Object.values(schema) as unknown[])
    .filter((value): value is PgTable => isTable(value))
    .map((table) => `"${getTableConfig(table).name}"`);

  if (names.length < MINIMUM_TABLES) {
    throw new Error(
      `test/postgres.ts found ${names.length} tables in the schema barrel, below the ` +
      `floor of ${MINIMUM_TABLES}. clearDb() would leave rows behind — fix the traversal ` +
      'rather than lowering the floor.'
    );
  }

  tableNames = names;
  return names;
}

/**
 * Open the pool against a disposable, migrated database.
 *
 * Which URL that is, and why `TEST_DATABASE_URL` wins, is
 * {@link resolveTestDatabaseUrl}'s to state.
 */
export async function connectDb(): Promise<void> {
  const url = resolveTestDatabaseUrl();

  /**
   * Before the pool opens, so a refused database is never even connected to.
   * `clearDb` asserts this too — it is the destructive call and has to be safe
   * on its own — but checking here is what makes the refusal FAIL FAST: a check
   * only in `clearDb` runs in `afterEach`, by which point the first test has
   * already written its fixtures into the database being protected.
   */
  assertDisposableDatabase(url);

  process.env.DATABASE_URL = url;

  await connectPostgres();

  const [migrated] = await getDb().execute<{ present: boolean }>(
    sql`select count(*) = ${quotedTableNames().length} as present
        from information_schema.tables
        where table_schema = 'public'`
  );

  if (!migrated?.present) {
    throw new Error(
      'TEST_DATABASE_URL points at a database whose table count does not match the schema. ' +
      'Run `bun run db:migrate` against it before running the suite.'
    );
  }
}

/**
 * Connect for a suite that manages its OWN rows — the `EXPLAIN` probes and
 * `gates.test.ts`, which seed large fixtures and clean up themselves rather than
 * truncating between tests.
 *
 * They used to call `connectPostgres()` directly, which meant the disposable
 * check never saw them: nine files opening a pool and writing fixtures into
 * whatever `DATABASE_URL` happened to name. They do not TRUNCATE, so the damage
 * was pollution rather than destruction — but "it only writes to the shared
 * database" is not a property worth relying on.
 *
 * It also settles the precedence. Seven of the nine already resolved
 * `TEST_DATABASE_URL ?? DATABASE_URL`; two used `||=`, which lets `DATABASE_URL`
 * WIN and sends a developer's run at whatever their local default names —
 * `syra_dev`, in the case this guard exists for. `gates.test.ts` records why that
 * ordering matters at length, having been fixed once already; this is the rest of
 * that sweep, in one place where it cannot be half-applied again.
 */
export async function connectUnmanagedDb(): Promise<void> {
  const url = resolveTestDatabaseUrl();
  assertDisposableDatabase(url);
  process.env.DATABASE_URL = url;
  await connectPostgres();
}

/**
 * Remove every row written by a test, leaving the schema intact.
 *
 * Re-asserts the database is disposable rather than trusting {@link connectDb}
 * to have done it: this is the call that actually destroys data, and a suite
 * that imports only this one (or resets `TEST_DATABASE_URL` between hooks) would
 * otherwise reach the TRUNCATE with nothing having checked.
 */
export async function clearDb(): Promise<void> {
  assertDisposableDatabase(resolveTestDatabaseUrl());
  await getDb().execute(sql.raw(`truncate table ${quotedTableNames().join(', ')} cascade`));
}

export async function disconnectDb(): Promise<void> {
  await closePostgres();
}
