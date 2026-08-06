/**
 * The four schema-convention gates every Oxy Postgres backend is held to,
 * imported from `@oxyhq/db/assert` and driven against THIS schema's own data:
 *
 *   - `findIdColumnViolations` — every `*_id`-shaped column is classified,
 *     via `schema/deferredForeignKeys.ts`'s two ledgers plus the real
 *     `.references()` constraints. Pure: reads the drizzle schema objects,
 *     no database needed.
 *   - `findImplicitWholeRowReads` — no bare `.select()` or `db.query.<table>`
 *     read of a table `schema/protectedColumns.ts` protects. Scans source,
 *     no database needed.
 *   - `findSchemaInvariantViolations` — schema-wide conventions (naming,
 *     casing, ...), checked against the MIGRATED database's own catalogue.
 *   - `findUnsupportedExpiryColumns` — every `db/expiry.ts` sweep target has
 *     a supporting index, checked against the same catalogue.
 *
 * The last two need a real, migrated Postgres — `beforeAll` connects to
 * `TEST_DATABASE_URL` (or `DATABASE_URL` as a local-dev fallback), the same
 * database `bun run db:migrate` was run against.
 *
 * `MINIMUM_TABLES` is a vacuity floor, not a target: fewer tables than this
 * means the traversal itself is broken (a wrong `sourceDir`, an empty
 * `schema` barrel import) rather than a clean schema. It is `0` only here,
 * because the schema really is empty — the first table this repo lands must
 * raise it in the same change, and every later schema task raises it again.
 * A floor that never moves is a vacuity check that stopped checking.
 */

import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import {
  findIdColumnViolations,
  findImplicitWholeRowReads,
  findSchemaInvariantViolations,
  findUnsupportedExpiryColumns,
} from '@oxyhq/db/assert';
import { closePostgres, connectPostgres, getDb } from '../postgres';
import * as schema from '../schema';
import { DEFERRED_FOREIGN_KEYS, ID_COLUMNS_WITHOUT_FOREIGN_KEY } from '../schema/deferredForeignKeys';
import { PROTECTED_COLUMNS_BY_TABLE } from '../schema/protectedColumns';
import { EXPIRY_SWEEP_TARGETS } from '../expiry';

/** Traversal floor for every gate below. See this file's own doc comment. */
const MINIMUM_TABLES = 0;

/** Every drizzle table the schema barrel exports, walked rather than listed by hand. */
function tables(): PgTable[] {
  return Object.values(schema).filter((value): value is PgTable => is(value, PgTable));
}

beforeAll(async () => {
  // `TEST_DATABASE_URL` is what CI's `postgres:17` service publishes; a local
  // run falls back to whatever `DATABASE_URL` a developer already has pointed
  // at their own `docker-compose.postgres.yml` instance. Neither overwrites
  // an already-set `DATABASE_URL` — a developer who exported one explicitly
  // keeps control of which database the suite touches.
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('schema gates', () => {
  it('classifies every id-shaped column', () => {
    const violations = findIdColumnViolations({
      tables: tables(),
      deferred: DEFERRED_FOREIGN_KEYS,
      withoutForeignKey: ID_COLUMNS_WITHOUT_FOREIGN_KEY,
      minimumTables: MINIMUM_TABLES,
    });
    expect(violations).toEqual([]);
  });

  it('has no implicit whole-row read of a protected table', async () => {
    // `src/`, not this file's own directory — the scan has to see every
    // consumer of a protected table, not just the ones under `db/`.
    const violations = await findImplicitWholeRowReads({
      sourceDir: join(__dirname, '..', '..'),
      registry: PROTECTED_COLUMNS_BY_TABLE,
    });
    expect(violations).toEqual([]);
  });

  it('keeps the migrated schema free of convention violations', async () => {
    const violations = await findSchemaInvariantViolations(getDb(), {
      minimumTables: MINIMUM_TABLES,
      minimumColumns: 0,
    });
    expect(violations).toEqual([]);
  });

  it('keeps every expiry sweep target indexed', async () => {
    const violations = await findUnsupportedExpiryColumns(getDb(), EXPIRY_SWEEP_TARGETS);
    expect(violations).toEqual([]);
  });
});
