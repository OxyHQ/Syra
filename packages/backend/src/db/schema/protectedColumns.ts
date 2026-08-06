/**
 * Columns That Must Not Reach a Client — the `select: false` replacement
 *
 * Mongoose can mark a field so sensitive it is absent from every read unless a
 * caller asks for it by name. Drizzle enumerates columns explicitly, so a
 * naive port keeps no such guard at all: `db.select().from(table)` returns
 * every column, secrets included, with nothing in the call site naming what
 * leaked.
 *
 * This module holds THIS schema's registry — decided once for every table
 * rather than per call site. The mechanism that reads it (`publicColumns`, the
 * implicit-whole-row-read scanner `findImplicitWholeRowReads`) is shared
 * plumbing with no opinion on which columns to protect, so it lives in
 * `@oxyhq/db/assert` instead of here; this file supplies only the DATA.
 *
 * ## The mechanism
 *
 * 1. **The registry is data** (`PROTECTED_COLUMNS_BY_TABLE`), one entry per
 *    table naming the columns it protects — the same shape as
 *    `deferredForeignKeys.ts`, and for the same reason: a rule written only
 *    in a comment is a rule nothing checks.
 * 2. **`publicColumns(table, PROTECTED_COLUMNS_BY_TABLE)`, imported from
 *    `@oxyhq/db/assert`, is the sanctioned read.**
 *    `db.select(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE)).from(users)`
 *    omits every protected column AT THE TYPE LEVEL — the resulting row type
 *    has no property for it at all, so a serializer that tries to read one
 *    fails `tsc` rather than shipping it.
 * 3. **Opting in is explicit and greppable.** A path that legitimately needs a
 *    protected column names it: `db.select({ id: t.id, secret: t.secret })`.
 *    There is deliberately no helper for this — the whole point is that it
 *    reads differently from an ordinary select.
 * 4. **`__tests__/gates.test.ts` is the gate.** It calls
 *    `@oxyhq/db/assert`'s `findImplicitWholeRowReads` to scan `src/` for the
 *    two shapes that return every column implicitly regardless of whether
 *    `publicColumns` exists — a bare `.select()` and the relational
 *    `db.query.<table>` API — against any table in this registry.
 *
 * Each schema task that ports a model with a Mongoose `select: false` field
 * (or any column that must not reach a client even though Mongoose never
 * marked it) adds an entry here in the same change.
 *
 * `PROTECTED_COLUMNS_BY_TABLE` must stay declared `as const` and be passed
 * straight through to `publicColumns` at every call site — see that
 * function's own doc comment in `@oxyhq/db/assert` for exactly what widening
 * it (an explicit `: ProtectedColumnRegistry` annotation, or passing it
 * through an intermediate parameter typed that way) would cost: the runtime
 * filter stays correct either way, but the compile-time guarantee collapses.
 *
 * Keyed here by SQL table name (`publicColumns`'s own contract — see its doc
 * comment in `@oxyhq/db/assert`), and each entry lists TypeScript PROPERTY
 * names, not SQL column names (`publicColumns` reads the registry against
 * `Object.entries(getTableColumns(table))`, whose keys are the drizzle
 * property names).
 *
 * `catalog_entities.images` / `catalog_entities.imageSuggestions` and
 * `tracks.images` / `tracks.sha256` are every field
 * `stripExternalCatalogFields` (`utils/musicHelpers.ts`) deletes today — see
 * that function's own doc comment for why each one is server-only. Thirteen
 * modules format tracks and catalog entities through it, so a field this
 * registry misses is exposed by all of them at once the moment a route stops
 * being a Mongoose `find()` (which honoured `select: false`) and becomes an
 * aggregation (which does not) — exactly what already happened once
 * (`imageSuggestions`, per that function's own doc comment).
 */

export const PROTECTED_COLUMNS_BY_TABLE = {
  catalog_entities: ['images', 'imageSuggestions'],
  tracks: ['images', 'sha256'],
} as const;
