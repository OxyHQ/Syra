/**
 * Id-Shaped Columns That Carry No Foreign Key
 *
 * Two ledgers, one purpose: between them and the real `.references()`
 * constraints, every id-shaped column in this schema is expected to be
 * classified — which is what lets `__tests__/gates.test.ts` fail on a NEW one
 * nobody decided about, via `@oxyhq/db/assert`'s `findIdColumnViolations`.
 *
 * `DEFERRED_FOREIGN_KEYS` is the TEMPORARY list: a constraint that is decided
 * but not yet expressible because drizzle cannot write a forward reference —
 * a table can land before its parent does. The gate turns each entry into a
 * hard error the moment the parent table appears in the barrel, naming every
 * column that must now reference it. An empty ledger is the finish line, and
 * it starts empty because there is no schema yet at all.
 *
 * `ID_COLUMNS_WITHOUT_FOREIGN_KEY` is the PERMANENT counterpart: `*_id`
 * columns that will never carry a constraint, each with its own reason. It
 * also starts empty for the same reason.
 *
 * Both `DeferredForeignKey` and the shape `findIdColumnViolations` expects for
 * `withoutForeignKey` come straight from `@oxyhq/db/assert` rather than being
 * redeclared here — the package now owns both the gate and the types it
 * consumes, so a second local copy could only drift from the one the gate
 * actually checks against.
 */

import type { DeferredForeignKey } from '@oxyhq/db/assert';

/**
 * Empty, and that is the starting line rather than an oversight: nothing has
 * landed yet. A table added ahead of its parent goes here with its
 * `ON DELETE` and reason already decided.
 */
export const DEFERRED_FOREIGN_KEYS: readonly DeferredForeignKey[] = [];

/**
 * `*_id`-shaped columns that will never carry a constraint, named by their SQL
 * identifier (`table.column`, via `sqlColumnName` — never the TypeScript
 * property name; see that function's own doc comment in `@oxyhq/db` for why).
 *
 * Empty for the same reason `DEFERRED_FOREIGN_KEYS` is: there is no schema yet.
 * `findIdColumnViolations` itself catches a stale entry (`stale_ledger_entry`)
 * or an incomplete one, so an entry added here ahead of the column it names
 * would fail loudly rather than silently drift.
 */
export const ID_COLUMNS_WITHOUT_FOREIGN_KEY: readonly { column: string; reason: string }[] = [];
