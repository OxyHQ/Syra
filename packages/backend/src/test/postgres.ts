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
 * ## The one thing this helper will not do
 *
 * It does not migrate. `TEST_DATABASE_URL` must already point at a migrated
 * database (`bun run db:migrate`), and {@link connectDb} asserts that rather
 * than discovering it as a confusing "relation does not exist" three layers
 * into a test: a suite running against an unmigrated database would otherwise
 * report failures that say nothing about the code under test.
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
 * Open the pool against `TEST_DATABASE_URL`, and prove the database is migrated.
 *
 * `TEST_DATABASE_URL` wins over `DATABASE_URL` when both are set, so a developer
 * whose `DATABASE_URL` points at something they care about cannot have it
 * truncated by running the suite.
 */
export async function connectDb(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL (or DATABASE_URL) must point at a migrated Postgres.');
  }
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

/** Remove every row written by a test, leaving the schema intact. */
export async function clearDb(): Promise<void> {
  await getDb().execute(sql.raw(`truncate table ${quotedTableNames().join(', ')} cascade`));
}

export async function disconnectDb(): Promise<void> {
  await closePostgres();
}
