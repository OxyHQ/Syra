# `@oxyhq/db` — extracting the Postgres plumbing

**Status:** design, approved 2026-08-05. Blocks the Syra port
([`2026-08-05-syra-mongo-to-postgres-design.md`](./2026-08-05-syra-mongo-to-postgres-design.md)).

**Where the work lands:** `OxyHQServices/packages/db`, published to npm. This spec
lives in the Syra repo because the Syra port is what forces it; when
implementation starts, the binding contract belongs in the package itself
(`packages/db/CONTRACT.md`), next to the code, for the same reason oxy-api's
migration contract does.

## Why this exists

oxy-api and Mention each ported MongoDB to PostgreSQL, and each wrote its own
copy of the same plumbing. The copies have already diverged:

| module | oxy-api | Mention | differing lines |
|---|---|---|---|
| `casing.ts` | 58 | 59 | 15 |
| `expiry.ts` | 294 | 331 | 313 |
| `extensions.ts` | 126 | 142 | 96 |
| `migrationLedger.ts` | 170 | 352 | 290 |
| `pgErrors.ts` | 87 | 148 | 81 |
| `migrate.ts` | 328 | 172 | 306 |

Syra would be the third copy, and roughly a dozen more backends follow it. The
ecosystem rule is that cross-cutting behaviour lives in the shared SDK, and a
Postgres substrate every backend needs is exactly that.

The divergence is not only volume. The approaches differ: oxy-api has
`migrationPhases.ts` plus a `check-migration-phases.mjs` gate, which Mention does
not have at all; Mention has `targetDatabase.ts` and `testDatabase.ts`, which
oxy-api does not. Neither repo has the whole mechanism.

## Prime directive

**Behaviour of the two shipped backends does not change.** The proof is that
oxy-api's and Mention's existing suites pass with **no test edited** — only
import paths move. Any change in behaviour is a bug in this extraction, not an
improvement, and belongs in a separate change afterwards.

## Resolving the divergence: choose, never merge

Merging two 300-line modules that have already diverged produces a third that
nobody has run. One implementation wins per module, and the loser is deleted.

| module | base | reason |
|---|---|---|
| `casing`, `pgErrors` | Mention | same mechanism; Mention's carry the `qualified()` case that reached production in oxy-api (a correlated subquery rendering a bare column name, returning `[]` with no error) |
| `expiry`, `migrationLedger`, `columns` | Mention | more evolved (331/352/265 lines vs 294/170/153) |
| `migrationPhases` + its CI gate | oxy-api | Mention has no counterpart |
| `extensions`, `targetDatabase`, `testDatabase` | Mention | oxy-api lacks the last two |

Two decisions inside that table are substantive rather than clerical:

- **`createdAt` uses `nowAtJsPrecision` (Mention), not `defaultNow()` (oxy-api).**
  Postgres stores microseconds and a JS `Date` holds milliseconds, so a value
  written by `defaultNow()` does not round-trip through the application. This is
  a correctness difference, not a style one. oxy-api adopting it is a
  behaviour change in the narrow sense — it is accepted deliberately and called
  out here, and its migration is verified against existing rows.
- **`planMigrationRun` exists in both**, with different signatures: the ledger's
  (Mention) and the deploy-phase planner's (oxy-api). Both are needed. One is
  renamed at implementation time, after reading both; the rename is a clean cut
  at every call site, with no alias left behind.

## Package shape

`drizzle-orm` and `postgres` are **peerDependencies**, not dependencies. Three
repos sharing drizzle types only works with a single installed copy. Both repos
already resolve `drizzle-orm` to exactly `0.45.2` (oxy-api's `catalog:` entry
resolves there), so there is no version skew to fix — only a peer range to pin.

Subpath exports, so the migration runner and the ephemeral-Postgres harness stay
out of the runtime bundle:

| subpath | contents |
|---|---|
| `@oxyhq/db` | `casing`, `pgErrors`, `columns`, `ids` |
| `@oxyhq/db/migrate` | ledger, deploy phases, `targetDatabase`, `extensions`, runner |
| `@oxyhq/db/expiry` | the sweep mechanism |
| `@oxyhq/db/testing` | `createTestDatabase` / `dropTestDatabase` |
| `@oxyhq/db/assert` | convention-gate helpers |

### Modules

1. **`casing`** — `DATABASE_CASING`, `sqlColumnName`, `qualified`.
2. **`pgErrors`** — SQLSTATE constants, `sqlStateOf`, `constraintNameOf`,
   `describeDriverError`, `isUniqueViolation` / `isForeignKeyViolation` /
   `isCheckViolation`. Doc comments are rewritten generically: no consumer app's
   name travels into a shared package.
3. **`columns`** — a **union**, because the two sides contribute independent
   helpers rather than rival versions: `timestamptz`, `createdAt`, `updatedAt`,
   `generatedId`, `uuidv7`, `tsvector`, `inList`, `numericInList`,
   `SelectedRow`, plus `bytea` (oxy-api only) and `geography` (Mention only).
4. **`ids`** — `uuidv7()` and the format validator.
5. **`migrate`** — ledger + deploy phases + `targetDatabase` + `extensions` +
   the runner. The extension LIST is a parameter; the mechanism is the package's.
6. **`expiry`** — `ExpirySweepTarget`, `sweepExpiredRows`, `sweepAllExpiredRows`.
   `EXPIRY_SWEEP_TARGETS` does **not** travel: it names application tables, so it
   becomes an argument.
7. **`testing`** — Mention's ephemeral-Postgres harness.
8. **`assert`** — the gates, and the highest-leverage part of the extraction,
   since a new consumer inherits the whole convention suite on day one:
   - schema invariants: snake_case tables and columns, every table has a primary
     key, every timestamp is `timestamptz`, no `''` default, no `_id` / `__v`
   - every `*_id` column is classified: real FK, deferred FK, or declared as
     never carrying one
   - `publicColumns(table, registry)` plus the scanner for implicit whole-row
     reads (a bare `select()` and the relational `db.query.<table>` API)
   - every expiry-registered column has a supporting btree index

**Assertion helpers are pure functions returning violations. They never call
`expect`.** The three consumers run three different test runners — jest
(oxy-api), vitest (Mention), `bun test` (Syra) — so a runner dependency would
make the package unusable in two of them.

### What does NOT move

Mention's `postgres.ts`. It reads its app's `config` and `schema`, and its
`getDb()` is a process singleton. The package exports a
`createDatabase({ url, schema, logger })` factory; each app keeps its own
singleton and its own connection lifecycle.

## Consumer order

1. **oxy-api** — in-repo, `workspace:*`, so the package and its first consumer
   move together and the API surface is proven before publishing.
2. **Mention** — from npm. This is the real test of the package boundary: a
   separate repo cannot reach into the monorepo for anything it forgot to export.
3. **Syra** — consumes it from its first commit; never writes a copy.

Each consumer migration is a clean cut: the local module is **deleted**, every
import updated, no re-export shim and no compatibility alias.

## Verification

- oxy-api and Mention: their own suites pass with no test file edited.
- Mutation: break a helper inside the package and confirm all three consumers go
  red naming the offending file. A helper that can be broken without any
  consumer noticing is either dead or untested — resolve which before shipping.
- Publish discipline: version bump committed and pushed to `main` first, then
  `bun pm pack`, inspect the tarball's manifest (peer ranges, no `workspace:`
  literal), publish, verify with a clean external install and import before
  bumping Mention.

## Risks, stated rather than discovered later

- Two production backends are refactored **before** a single line of Syra runs on
  Postgres. That is the cost of extracting first, accepted knowingly.
- `@oxyhq/db` becomes a release dependency of every backend's migrations. A bad
  publish is an ecosystem-wide event, which is why oxy-api moves first inside the
  monorepo and Mention proves the boundary from npm.
- The `createdAt` precision change is a real behaviour change in oxy-api. It is
  the one place this extraction is not behaviour-preserving, and it is called out
  so that it is reviewed as a change rather than absorbed as a refactor.
