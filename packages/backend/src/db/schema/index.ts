/**
 * Drizzle Schema Barrel
 *
 * One module per table under `src/db/schema/`, each re-exported from here.
 * This file is the single entry point `drizzle.config.ts` generates
 * migrations from AND the object `db/postgres.ts` hands to `drizzle()` for the
 * relational query API — a table that is not re-exported here is invisible to
 * both, so it gets neither a migration nor a typed query.
 *
 * Only TABLE modules belong here. `deferredForeignKeys.ts` and
 * `protectedColumns.ts` are schema support, imported directly by the code
 * that needs them; the shared column builders every table uses (`createdAt`,
 * `generatedId`, `timestamptz`, ...) live in `@oxyhq/db`, not in a local copy.
 *
 * `__tests__/gates.test.ts` derives its own `tables` list from
 * `Object.values(schema)`, the same way every gate in this barrel's two
 * sibling ports (oxy-api, Mention) does, rather than this file exporting a
 * hand-maintained array: a table added via `export * from './vertical'` and
 * left out of a separately-maintained list is exactly the "convention nothing
 * checks" failure this schema's own gates exist to close.
 */

export * from './catalog';
export * from './creators';
export * from './genres';
export * from './library';
export * from './moderation';
export * from './podcasts';
export * from './rooms';
export * from './trackKeys';
export * from './user';
