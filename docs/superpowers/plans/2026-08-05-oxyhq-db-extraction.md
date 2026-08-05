# `@oxyhq/db` Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the duplicated MongoDB→PostgreSQL plumbing out of oxy-api and Mention into a published `@oxyhq/db` package, and migrate both backends onto it, so Syra (and every backend after it) inherits the mechanism and its convention gates instead of writing a third copy.

**Architecture:** A new workspace package `OxyHQServices/packages/db`, built like `@oxyhq/federation` (tsc → cjs + esm + types, `files: ["dist","src"]`), exposing five subpaths. It contains mechanism only — no application schema. Registries that name application tables (expiry targets, required extensions, protected columns, deferred foreign keys) become **parameters**. The convention gates ship as pure functions returning violation lists, never `expect` calls, because the three consumers run three different test runners.

**Tech Stack:** TypeScript 5.9, Drizzle ORM 0.45.2 over `postgres.js` 3.4.9 (both peer dependencies), bun workspaces, jest inside the package, npm publish via release-it.

**Spec:** [`../specs/2026-08-05-oxyhq-db-extraction-design.md`](../specs/2026-08-05-oxyhq-db-extraction-design.md)

## Global Constraints

- **bun only.** Never `npm`, never `yarn`, never `npx` — use `bunx`. After any dependency change run `bun install` and commit `bun.lock` **in the same commit**.
- **`drizzle-orm` and `postgres` are `peerDependencies`, never `dependencies`.** Both repos resolve `drizzle-orm` to exactly `0.45.2` and `postgres` to `3.4.9` today. Peer range: `"drizzle-orm": "^0.45.2"`, `"postgres": "^3.4.9"`.
- **Behaviour of oxy-api and Mention does not change.** The proof is their existing suites passing with **no test file edited** — only import paths move. The single deliberate exception is the `createdAt` precision change in oxy-api (Task 3), which is reviewed as a change.
- **Choose, never merge.** One implementation wins per module; the loser is deleted. Base per module: `casing`, `pgErrors`, `expiry`, `migrationLedger`, `columns`, `extensions`, `targetDatabase`, `testDatabase` → Mention. `migrationPhases` + its CI gate → oxy-api.
- **Clean cut on every consumer migration.** The local module is deleted, every import rewritten. No re-export shim, no barrel file, no compatibility alias, no `@deprecated`.
- **Assertion helpers never call `expect`.** oxy-api runs jest, Mention runs vitest, Syra runs `bun test`.
- **No application name travels into the package.** Doc comments moved from Mention or oxy-api are rewritten generically. A comment naming `posts.geo` or `users.hashed_email` in a shared package is wrong even when the code is right.
- Standing repo rules: no `as any`, no `@ts-ignore` / `@ts-expect-error`, no `!` non-null assertion, no `any` in a signature, no silent `catch {}`, no TODO/FIXME/HACK, no `console.log`.
- **Publish discipline:** the version bump and its content are committed and pushed to `main` FIRST. Then `bun pm pack`, read `dependencies`/`peerDependencies` out of the packed manifest (`tar -xzOf <tgz> package/package.json`), confirm no literal `workspace:` survives, then publish. Verify with a clean external install and import before bumping any consumer.

---

## File Structure

**Created — `OxyHQServices/packages/db/`:**

| path | responsibility |
|---|---|
| `package.json`, `tsconfig*.json`, `jest.config.js` | package build + test wiring, modelled on `packages/federation` |
| `src/index.ts` | barrel for the root subpath |
| `src/casing.ts` | `DATABASE_CASING`, `sqlColumnName`, `qualified` |
| `src/pgErrors.ts` | SQLSTATE constants and driver-error predicates |
| `src/columns.ts` | drizzle column helpers shared by every schema |
| `src/ids.ts` | `uuidv7()` and its format validator |
| `src/database.ts` | `SqlExecutor`, `createDatabase()` factory |
| `src/migrate/index.ts` | barrel for `@oxyhq/db/migrate` |
| `src/migrate/ledger.ts` | journal reading, applied high-water mark, pending plan |
| `src/migrate/phases.ts` | deploy-phase markers and the phased run planner |
| `src/migrate/targetDatabase.ts` | the "am I pointed at the right database" guard |
| `src/migrate/extensions.ts` | `ensureExtensions(url, extensions)` |
| `src/migrate/runner.ts` | `runMigrations(...)` — extensions, then target guard, then drizzle |
| `src/expiry.ts` | the TTL-replacement sweep, registry supplied by the caller |
| `src/testing.ts` | `createTestDatabase` / `dropTestDatabase` |
| `src/assert/schemaInvariants.ts` | information_schema invariants → violations |
| `src/assert/idColumns.ts` | every `*_id` column classified → violations |
| `src/assert/protectedColumns.ts` | `publicColumns()` + implicit-whole-row-read scanner |
| `src/assert/expiryIndexes.ts` | every swept column has a supporting btree index |
| `src/assert/index.ts` | barrel for `@oxyhq/db/assert` |

**Deleted — oxy-api** (`packages/api/src/db/`): `casing.ts`, `pgErrors.ts`, `extensions.ts`, `migrate.ts`, `migrationLedger.ts`, `migrationPhases.ts`, `expiry.ts`, and the generic half of `schema/columns.ts`. Import sites to rewrite: casing 17, pgErrors 10, expiry 6, extensions 3, migrationLedger 5, migrationPhases 2, columns 98.

**Deleted — Mention** (`packages/backend/src/db/`): `casing.ts`, `pgErrors.ts`, `extensions.ts`, `migrate.ts`, `migrationLedger.ts`, `expiry.ts` (mechanism half), `targetDatabase.ts`, `testDatabase.ts`, `ids.ts`, and the generic half of `schema/columns.ts`. Import sites to rewrite: casing 19, pgErrors 28, expiry 2, extensions 1, migrationLedger 3, targetDatabase 4, testDatabase 1, ids 5, columns 51.

Application-specific files **stay** in their repos: every `schema/*.ts`, `deferredForeignKeys.ts`, `protectedColumns.ts` (the registry — the mechanism moves, the data does not), the `EXPIRY_SWEEP_TARGETS` and `REQUIRED_EXTENSIONS` arrays, `config/postgres.ts` / `db/postgres.ts`, and `drizzle.config.ts`.

---

### Task 1: Package scaffold and `casing`

The first module carries the scaffold because a scaffold with nothing in it has nothing to test. `casing` is the right first passenger: it is the smallest module, it has zero application coupling, and 36 import sites across the two consumers depend on it.

**Files:**
- Create: `OxyHQServices/packages/db/package.json`
- Create: `OxyHQServices/packages/db/tsconfig.json`, `tsconfig.cjs.json`, `tsconfig.esm.json`, `tsconfig.types.json`
- Create: `OxyHQServices/packages/db/jest.config.js`
- Create: `OxyHQServices/packages/db/src/casing.ts`
- Create: `OxyHQServices/packages/db/src/index.ts`
- Create: `OxyHQServices/packages/db/src/__tests__/casing.test.ts`
- Modify: `OxyHQServices/package.json` (add `"packages/db"` to `workspaces.packages`)
- Source to copy from: `Mention/packages/backend/src/db/casing.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DATABASE_CASING: Casing`, `sqlColumnName(column: Column): string`, `qualified(column: Column): SQL` — exported from `@oxyhq/db`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/__tests__/casing.test.ts`:

```ts
import { getTableName, sql } from 'drizzle-orm';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { DATABASE_CASING, qualified, sqlColumnName } from '../casing';

const sessions = pgTable('sessions', {
  id: text().primaryKey(),
  expiresAt: timestamp({ withTimezone: true, mode: 'date' }),
  legacy: text('legacy_name'),
});

describe('casing', () => {
  it('uses snake_case as the one naming convention', () => {
    expect(DATABASE_CASING).toBe('snake_case');
  });

  it('derives the SQL name from the TypeScript property', () => {
    // The trap: `column.name` is `expiresAt`, which no Postgres column is called.
    expect(sqlColumnName(sessions.expiresAt)).toBe('expires_at');
  });

  it('honours an explicitly named column instead of re-deriving it', () => {
    expect(sqlColumnName(sessions.legacy)).toBe('legacy_name');
  });

  it('qualifies a column with its table, so a correlated subquery cannot rebind it', () => {
    const chunk = qualified(sessions.expiresAt);
    const rendered = sql`select 1 where ${chunk} is null`;
    expect(getTableName(sessions.expiresAt.table)).toBe('sessions');
    expect(rendered.queryChunks.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: the filter matches no package — `@oxyhq/db` does not exist yet.

- [ ] **Step 3: Create the package manifest**

`packages/db/package.json`. Modelled on `packages/federation/package.json`, minus the ActivityPub-specific parts, plus the five subpath exports.

```json
{
  "name": "@oxyhq/db",
  "version": "0.1.0",
  "description": "Oxy Postgres substrate — drizzle column and naming helpers, driver-error predicates, the migration ledger and deploy-phase planner, the TTL-replacement sweep, an ephemeral-database harness, and the schema-convention gates every Oxy backend is held to.",
  "main": "dist/cjs/index.js",
  "module": "dist/esm/index.js",
  "types": "dist/types/index.d.ts",
  "source": "src/index.ts",
  "sideEffects": false,
  "publishConfig": { "access": "public" },
  "exports": {
    ".": {
      "import": { "types": "./dist/types/index.d.ts", "default": "./dist/esm/index.js" },
      "require": { "types": "./dist/types/index.d.ts", "default": "./dist/cjs/index.js" },
      "default": "./dist/esm/index.js"
    },
    "./migrate": {
      "import": { "types": "./dist/types/migrate/index.d.ts", "default": "./dist/esm/migrate/index.js" },
      "require": { "types": "./dist/types/migrate/index.d.ts", "default": "./dist/cjs/migrate/index.js" },
      "default": "./dist/esm/migrate/index.js"
    },
    "./expiry": {
      "import": { "types": "./dist/types/expiry.d.ts", "default": "./dist/esm/expiry.js" },
      "require": { "types": "./dist/types/expiry.d.ts", "default": "./dist/cjs/expiry.js" },
      "default": "./dist/esm/expiry.js"
    },
    "./testing": {
      "import": { "types": "./dist/types/testing.d.ts", "default": "./dist/esm/testing.js" },
      "require": { "types": "./dist/types/testing.d.ts", "default": "./dist/cjs/testing.js" },
      "default": "./dist/esm/testing.js"
    },
    "./assert": {
      "import": { "types": "./dist/types/assert/index.d.ts", "default": "./dist/esm/assert/index.js" },
      "require": { "types": "./dist/types/assert/index.d.ts", "default": "./dist/cjs/assert/index.js" },
      "default": "./dist/esm/assert/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": ["dist", "src"],
  "keywords": ["oxyhq", "postgres", "drizzle", "migrations", "schema"],
  "repository": {
    "type": "git",
    "url": "https://github.com/OxyHQ/OxyHQServices",
    "directory": "packages/db"
  },
  "author": "OxyHQ",
  "license": "AGPL-3.0-only",
  "homepage": "https://oxy.so",
  "engines": { "node": ">=18.0.0" },
  "scripts": {
    "build": "bun run build:cjs && bun run build:esm && bun run build:types",
    "build:cjs": "tsc -p tsconfig.cjs.json",
    "build:esm": "tsc -p tsconfig.esm.json",
    "build:types": "tsc -p tsconfig.types.json",
    "clean": "rm -rf dist",
    "typescript": "tsc --noEmit",
    "test": "jest --passWithNoTests",
    "lint": "biome lint --error-on-warnings ./src",
    "prepublishOnly": "node ../../scripts/assert-bun-publish.mjs && bun run clean && bun run build",
    "release": "rm -rf dist && bun run build && release-it"
  },
  "release-it": {
    "git": {
      "tagName": "@oxyhq/db@${version}",
      "tagAnnotation": "Release @oxyhq/db@${version}",
      "commitMessage": "chore(db): release @oxyhq/db@${version}"
    },
    "github": { "release": true, "releaseName": "@oxyhq/db@${version}" },
    "npm": { "publish": true }
  },
  "peerDependencies": {
    "drizzle-orm": "^0.45.2",
    "postgres": "^3.4.9"
  },
  "devDependencies": {
    "@biomejs/biome": "catalog:",
    "@types/jest": "^30.0.0",
    "@types/node": "^22.20.1",
    "drizzle-orm": "catalog:",
    "jest": "^29.7.0",
    "postgres": "catalog:",
    "release-it": "catalog:",
    "ts-jest": "^29.4.11",
    "typescript": "^5.9.2"
  }
}
```

**Do not skip the ESM import-extension question.** `@oxyhq/federation` runs `node scripts/fix-esm-imports.mjs` after `build:esm` because its `moduleResolution: "bundler"` emits extensionless relative imports that Node's ESM loader rejects. Verify in Step 8 whether this package needs the same; if the ESM smoke import fails with `ERR_MODULE_NOT_FOUND`, copy `packages/federation/scripts/fix-esm-imports.mjs` and append it to `build:esm` exactly as federation does.

- [ ] **Step 4: Create the tsconfigs**

`packages/db/tsconfig.json` — copy `packages/federation/tsconfig.json` verbatim; it is already correct for this package (ES2020 target, strict, `noEmit`, `include: ["src"]`, `exclude` includes `**/__tests__`). Then `tsconfig.cjs.json`, `tsconfig.esm.json` and `tsconfig.types.json`: copy federation's three, changing nothing but any `outDir` path that mentions federation.

- [ ] **Step 5: Create `jest.config.js`**

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
};
```

- [ ] **Step 6: Move `casing.ts`**

Copy `Mention/packages/backend/src/db/casing.ts` to `packages/db/src/casing.ts` unchanged in code. **Rewrite the doc comments so no application is named**: the `qualified()` comment currently cites `${likes.postId} = ${posts.id}`, "the sibling oxy-api port", and "Mention's social graph". Keep the mechanism and the warning; replace the example with a neutral one and the attribution with "this shipped in a production consumer: a correlated subquery rendered both names bare, so the predicate compared two of the subquery's own columns and returned `[]` with no error."

Create `packages/db/src/index.ts`:

```ts
export { DATABASE_CASING, qualified, sqlColumnName } from './casing';
```

- [ ] **Step 7: Register the workspace and install**

Add `"packages/db"` to `workspaces.packages` in the root `package.json`, immediately after `"packages/federation"`. Then:

```bash
cd /home/nate/Oxy/OxyHQServices && bun install
```

- [ ] **Step 8: Run the tests and the build**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test && bun run --filter @oxyhq/db build && bun run --filter @oxyhq/db typescript
```

Expected: 4 passing tests, `dist/{cjs,esm,types}` populated. Then prove the built ESM entry actually loads under Node's resolver, which is what the `fix-esm-imports` question in Step 3 hangs on:

```bash
cd /home/nate/Oxy/OxyHQServices/packages/db && node -e "import('./dist/esm/index.js').then(m => console.log(Object.keys(m)))"
```

Expected: `[ 'DATABASE_CASING', 'qualified', 'sqlColumnName' ]`. If it fails with `ERR_MODULE_NOT_FOUND`, apply the federation `fix-esm-imports.mjs` step and re-run.

- [ ] **Step 9: Commit**

```bash
git add packages/db package.json bun.lock
git commit -m "feat(db): scaffold @oxyhq/db and move the column-naming authority into it"
```

---

### Task 2: `pgErrors`

**Files:**
- Create: `OxyHQServices/packages/db/src/pgErrors.ts`
- Create: `OxyHQServices/packages/db/src/__tests__/pgErrors.test.ts`
- Modify: `OxyHQServices/packages/db/src/index.ts`
- Source to copy from: `Mention/packages/backend/src/db/pgErrors.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, from `@oxyhq/db`: `UNIQUE_VIOLATION`, `FOREIGN_KEY_VIOLATION`, `CHECK_VIOLATION`, `GENERATED_ALWAYS`, `SERIALIZATION_FAILURE`, `DEADLOCK_DETECTED`, `QUERY_CANCELED` (all `string`); `sqlStateOf(error: unknown): string | undefined`; `constraintNameOf(error: unknown): string | undefined`; `describeDriverError(error: unknown): { code?: string; constraint?: string; kind: string }`; `isUniqueViolation(error: unknown, constraintName?: string): boolean`; `isForeignKeyViolation(...)`, `isCheckViolation(...)` with the same signature.

- [ ] **Step 1: Write the failing test**

`packages/db/src/__tests__/pgErrors.test.ts`. The load-bearing case is the wrapped error — a predicate reading `error.code` directly matches nothing, and every call site is a `catch` that rethrows, so the failure looks like an unrelated 500.

```ts
import {
  UNIQUE_VIOLATION,
  constraintNameOf,
  describeDriverError,
  isUniqueViolation,
  sqlStateOf,
} from '../pgErrors';

/** How drizzle presents a postgres.js failure: the real fields live on `cause`. */
function wrapped(code: string, constraintName: string): Error {
  const driver = new Error('duplicate key value violates unique constraint');
  Reflect.set(driver, 'code', code);
  Reflect.set(driver, 'constraint_name', constraintName);
  const wrapper = new Error('Failed query');
  Reflect.set(wrapper, 'cause', driver);
  return wrapper;
}

describe('pgErrors', () => {
  it('reads the SQLSTATE through the wrapper', () => {
    expect(sqlStateOf(wrapped(UNIQUE_VIOLATION, 'sessions_token_unique'))).toBe(UNIQUE_VIOLATION);
  });

  it('reads constraint_name, the wire field, not `constraint`', () => {
    expect(constraintNameOf(wrapped(UNIQUE_VIOLATION, 'sessions_token_unique')))
      .toBe('sessions_token_unique');
  });

  it('matches a unique violation only on the NAMED constraint when one is given', () => {
    const error = wrapped(UNIQUE_VIOLATION, 'sessions_token_unique');
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(error, 'sessions_token_unique')).toBe(true);
    expect(isUniqueViolation(error, 'some_other_unique')).toBe(false);
  });

  it('returns undefined rather than a wrong answer for a non-driver error', () => {
    expect(sqlStateOf(new Error('nope'))).toBeUndefined();
    expect(isUniqueViolation(new Error('nope'))).toBe(false);
  });

  it('terminates on a cyclic cause chain instead of hanging inside a catch', () => {
    const a = new Error('a');
    const b = new Error('b');
    Reflect.set(a, 'cause', b);
    Reflect.set(b, 'cause', a);
    expect(sqlStateOf(a)).toBeUndefined();
  });

  it('describes a failure without publishing the statement or its parameters', () => {
    const error = wrapped(UNIQUE_VIOLATION, 'sessions_token_unique');
    Reflect.set(Reflect.get(error, 'cause') as object, 'query', 'insert into sessions ...');
    Reflect.set(Reflect.get(error, 'cause') as object, 'params', ['secret-token']);

    const described = describeDriverError(error);

    expect(described).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: 'sessions_token_unique',
      kind: 'Error',
    });
    expect(JSON.stringify(described)).not.toContain('secret-token');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: FAIL, `Cannot find module '../pgErrors'`.

- [ ] **Step 3: Move the module**

Copy `Mention/packages/backend/src/db/pgErrors.ts` to `packages/db/src/pgErrors.ts`, code unchanged. Rewrite the header comment: drop the enumeration of Mention's call sites (the MTN chain, starter packs, `federation.activityId`) and the "two administrative sweeps that logged post ids" story, keeping the RULE both illustrate — the whole error object is not loggable, because postgres.js attaches `query` and `params` and Postgres's `detail` reads `Failing row contains (…)`, and a uuid v7 primary key is not the shape an ObjectId redactor recognises.

Append to `packages/db/src/index.ts`:

```ts
export {
  CHECK_VIOLATION,
  DEADLOCK_DETECTED,
  FOREIGN_KEY_VIOLATION,
  GENERATED_ALWAYS,
  QUERY_CANCELED,
  SERIALIZATION_FAILURE,
  UNIQUE_VIOLATION,
  constraintNameOf,
  describeDriverError,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  sqlStateOf,
} from './pgErrors';
```

- [ ] **Step 4: Run the tests**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: PASS, 10 tests total.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src
git commit -m "feat(db): move the driver-error predicates into @oxyhq/db"
```

---

### Task 3: `columns` and `ids`

The union of both repos' helpers, because the two sides contribute independent helpers rather than rival versions. This is the module 149 import sites depend on (98 in oxy-api, 51 in Mention).

**Files:**
- Create: `OxyHQServices/packages/db/src/columns.ts`, `src/ids.ts`
- Create: `OxyHQServices/packages/db/src/__tests__/columns.test.ts`
- Modify: `OxyHQServices/packages/db/src/index.ts`
- Sources: `Mention/packages/backend/src/db/schema/columns.ts` (base), `Mention/packages/backend/src/db/ids.ts`, and `bytea` from `OxyHQServices/packages/api/src/db/schema/columns.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, from `@oxyhq/db`: `timestamptz()`, `createdAt()`, `updatedAt()`, `generatedId()`, `tsvector`, `geography`, `bytea`, `inList(values: readonly string[]): string`, `numericInList(values: readonly number[]): string`, `textArrayLiteral(values: readonly string[]): string`, `type SelectedRow<T>`, `uuidv7(): string`, `isLiveEntityId(value: unknown): boolean`.

- [ ] **Step 1: Write the failing test**

`packages/db/src/__tests__/columns.test.ts`:

```ts
import { createdAt, inList, numericInList, uuidv7 } from '../columns';
import { isLiveEntityId } from '../ids';

describe('uuidv7', () => {
  it('produces a v7 uuid', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('sorts lexicographically in generation order', () => {
    const ids = Array.from({ length: 50 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
  });

  it('accepts its own output as a live entity id', () => {
    expect(isLiveEntityId(uuidv7())).toBe(true);
    expect(isLiveEntityId('not-an-id')).toBe(false);
  });
});

describe('createdAt', () => {
  it('defaults at JS millisecond precision, so a written row round-trips', () => {
    // Postgres stores microseconds and a JS Date holds milliseconds. A
    // `defaultNow()` default produces a value the application cannot reproduce.
    const column = createdAt();
    const defaultValue = column.default;
    expect(defaultValue).toBeDefined();
    expect(String(defaultValue)).not.toMatch(/^now\(\)$/i);
  });
});

describe('inList', () => {
  it('renders a SQL value list a CHECK constraint can use', () => {
    expect(inList(['a', 'b'])).toBe("'a', 'b'");
  });

  it('refuses a value containing a quote rather than emitting injectable SQL', () => {
    expect(() => inList(["a'; drop table users; --"])).toThrow();
  });

  it('renders numbers without quoting them', () => {
    expect(numericInList([1, 2])).toBe('1, 2');
  });
});
```

Read Mention's `inList`/`numericInList` before writing the last three assertions and match the real return format and the real rejection behaviour — if it does not currently reject a quoted value, that is a finding to raise, not a behaviour to invent here.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: FAIL, `Cannot find module '../columns'`.

- [ ] **Step 3: Move and unify**

Copy Mention's `schema/columns.ts` to `packages/db/src/columns.ts` and Mention's `ids.ts` to `packages/db/src/ids.ts`. Then add `bytea` from oxy-api's `schema/columns.ts` verbatim, and `textArrayLiteral` if oxy-api's version is not already present in Mention's.

**`createdAt` uses Mention's `nowAtJsPrecision`, for all three consumers.** oxy-api's `defaultNow()` is dropped. This is the one deliberate behaviour change in the extraction — record it in the commit message so it is reviewed as a change and not absorbed as a refactor.

Export both modules from `src/index.ts`.

- [ ] **Step 4: Run the tests**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test && bun run --filter @oxyhq/db typescript
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src
git commit -m "feat(db): unify the drizzle column helpers, on JS-millisecond created_at

oxy-api defaulted created_at with defaultNow(); Mention with nowAtJsPrecision.
Postgres stores microseconds and a JS Date holds milliseconds, so a defaultNow()
value does not round-trip through the application. Mention's wins for all
consumers — a deliberate behaviour change in oxy-api, not a refactor."
```

---

### Task 4: The database handle — `SqlExecutor` and `createDatabase`

Every later module needs to accept "a thing you can run SQL on" without importing any application's schema. Mention's `Database` type is `PostgresJsDatabase<typeof schema>`, which is exactly the coupling that cannot travel.

**Files:**
- Create: `OxyHQServices/packages/db/src/database.ts`
- Create: `OxyHQServices/packages/db/src/__tests__/database.test.ts`
- Modify: `OxyHQServices/packages/db/src/index.ts`

**Interfaces:**
- Consumes: `DATABASE_CASING` from `./casing`.
- Produces, from `@oxyhq/db`: `type SqlExecutor` (structural: `execute(query: SQL): Promise<Record<string, unknown>[]>`), `executeRows<TRow extends Record<string, unknown>>(executor: SqlExecutor, query: SQL): Promise<TRow[]>`, `type OxyDatabase<TSchema extends Record<string, unknown>>`, `createDatabase<TSchema>(options: CreateDatabaseOptions<TSchema>): { db: OxyDatabase<TSchema>; client: postgres.Sql }`.

**`execute` is NOT generic on the method, and that is load-bearing.** The obvious
`execute<T>(query: SQL): Promise<T[]>` does not type-check against a real
`PostgresJsDatabase` or a real transaction handle — drizzle's
`PgRaw`/`RowList` nesting fails an unconstrained method generic with TS2322, so
the one property this type exists to provide would be absent. Row typing moves to
the free function `executeRows`. A `Pick<PgDatabase<…>, 'execute'>` alias fixes
real-handle assignability and keeps row typing, but breaks assignability from any
plain fake object AND narrows the parameter to `string | SQLWrapper`, so every
fake-driven test in Tasks 8, 10 and 11 would fail — measured, not reasoned.

- [ ] **Step 1: Write the failing test**

`packages/db/src/__tests__/database.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../database';

describe('SqlExecutor', () => {
  it('is satisfied by anything that can run a drizzle SQL chunk', async () => {
    const calls: string[] = [];
    const fake: SqlExecutor = {
      execute: async (query: Parameters<SqlExecutor['execute']>[0]): Promise<Record<string, unknown>[]> => {
        calls.push(query.queryChunks.length > 0 ? 'chunked' : 'empty');
        return [] as T[];
      },
    };

    await fake.execute(sql`select 1`);

    expect(calls).toEqual(['chunked']);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: FAIL, `Cannot find module '../database'`.

- [ ] **Step 3: Implement**

```ts
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { SQL } from 'drizzle-orm';
import postgres from 'postgres';
import { DATABASE_CASING } from './casing';

/**
 * The narrowest thing a mechanism in this package needs: something that can run
 * a drizzle SQL chunk and hand back rows.
 *
 * Declared structurally rather than as `PostgresJsDatabase<typeof schema>`,
 * because that type names the CONSUMER's schema and nothing in a shared package
 * may. A transaction handle satisfies it as readily as a pool does, which is
 * what lets a sweep or a gate run inside one.
 */
export interface SqlExecutor {
  execute(query: SQL): Promise<Record<string, unknown>[]>;
}

/**
 * Row typing at the call site, as a free function rather than a method generic.
 *
 * A generic METHOD on the interface would make a real drizzle handle
 * unassignable to it; a generic FUNCTION over the interface costs the caller
 * nothing and keeps both real handles and plain fakes assignable.
 */
export async function executeRows<TRow extends Record<string, unknown>>(
  executor: SqlExecutor,
  query: SQL
): Promise<TRow[]> {
  return (await executor.execute(query)) as TRow[];
}

/** A drizzle handle over the consumer's own schema. */
export type OxyDatabase<TSchema extends Record<string, unknown>> = PostgresJsDatabase<TSchema>;

export interface CreateDatabaseOptions<TSchema extends Record<string, unknown>> {
  readonly url: string;
  readonly schema: TSchema;
  /** postgres.js pool options. The caller owns pool sizing and timeouts. */
  readonly client?: postgres.Options<Record<string, never>>;
}

/**
 * Build a drizzle handle and the client underneath it.
 *
 * Deliberately NOT a singleton: process lifecycle, health checks and shutdown
 * ordering differ per application, so each one keeps its own. What this
 * guarantees is the part that must NOT differ — that the handle is built with
 * `DATABASE_CASING`, so the SQL queries reference matches the SQL migrations
 * created.
 */
export function createDatabase<TSchema extends Record<string, unknown>>(
  options: CreateDatabaseOptions<TSchema>
): { db: OxyDatabase<TSchema>; client: postgres.Sql } {
  const client = postgres(options.url, options.client);
  return {
    db: drizzle(client, { schema: options.schema, casing: DATABASE_CASING }),
    client,
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test && bun run --filter @oxyhq/db typescript
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src
git commit -m "feat(db): schema-agnostic database handle and SqlExecutor"
```

---

### Task 4b: Restore type-checking of test files

Discovered during Task 4, verified twice: this package's Jest run does not
type-check test files at all. Appending `const x: number = 'not a number';` to
`packages/db/src/__tests__/casing.test.ts` leaves `bun run --filter @oxyhq/db test`
reporting 26/26 passed, exit 0.

Every test file in the package has been unchecked since Task 1, so a type-level
assertion written under `__tests__` proves nothing. That matters most for Task 11,
whose whole contract is that `publicColumns` excludes AT THE TYPE LEVEL so a leak
fails `tsc` rather than shipping — a claim this package currently cannot test
where tests live.

**Files:**
- Modify: `packages/db/jest.config.js`, and/or `packages/db/tsconfig.json`, whichever the diagnosis names
- Test: the mutation below IS the test

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable — this restores a gate.

- [ ] **Step 1: Reproduce, and record the exact output**

```bash
cd /home/nate/Oxy/OxyHQServices/packages/db
printf '\nconst deliberateTypeError: number = "not a number";\nvoid deliberateTypeError;\n' >> src/__tests__/casing.test.ts
bun run --filter @oxyhq/db test
```

Expected today: the suite PASSES. That is the defect.

- [ ] **Step 2: Diagnose the real cause before changing anything**

Two candidates, and they need different fixes: ts-jest's own `isolatedModules` /
`transpilation` option (deprecated in ts-jest 29, read from its transform config),
versus `compilerOptions.isolatedModules` in `tsconfig.json`. Establish which one
this package is actually hitting by reading the installed ts-jest's source, not by
assuming. Report what you found.

Do NOT reflexively delete `isolatedModules` from `tsconfig.json`: it is inherited
from `packages/federation`'s config, it is required for correct single-file
transpilation, and removing it may be both wrong and insufficient.

- [ ] **Step 3: Fix so a type error in a test file fails the suite**

- [ ] **Step 4: Prove the restored gate can fail**

With the deliberate type error still present, `bun run --filter @oxyhq/db test`
must now FAIL and name `casing.test.ts`. Then remove the injected lines, confirm
`git diff --exit-code packages/db/src/__tests__/casing.test.ts` is silent, and
confirm the suite is green again.

- [ ] **Step 5: Report whether the four existing test files still type-check**

Turning the gate on may surface real type errors that were always there. Fix them
if they are genuine, and say what they were. If any of them turns out to be a
test asserting something untrue, that is a finding, not a cleanup.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "fix(db): type-check test files, so a type error in a test fails the suite"
```

---

### Task 5: `migrate` — ledger and target guard

**Files:**
- Create: `OxyHQServices/packages/db/src/migrate/ledger.ts`, `src/migrate/targetDatabase.ts`, `src/migrate/index.ts`
- Create: `OxyHQServices/packages/db/src/__tests__/ledger.test.ts`
- Sources: `Mention/packages/backend/src/db/migrationLedger.ts`, `Mention/packages/backend/src/db/targetDatabase.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, from `@oxyhq/db/migrate`: `MIGRATIONS_SCHEMA`, `MIGRATIONS_TABLE`, `type JournalEntry`, `readJournal(folder: string): JournalEntry[]`, `pendingEntries(...)`, `UnreachableMigrationError`, `highWaterMillis(appliedMillis: readonly number[]): number | null`, `unreachableEntries(...)`, `planLedgerRun(...)`, `readAppliedMillis(client: postgres.Sql): Promise<number[]>`, `readLastAppliedMillis(client: postgres.Sql): Promise<number | null>`, `assertPostgresMigrationsCurrent(...)`, `WrongMigrationTargetError`, `MissingMigrationTargetError`, `readTargetDatabase(argv: readonly string[]): string`, `assertMigrationTarget(client: Sql, expected: string): Promise<void>`.

**The rename:** Mention's ledger exports `planMigrationRun` and oxy-api's phases module exports a different `planMigrationRun`. Both are needed. The ledger's becomes **`planLedgerRun`**; the phases one keeps `planMigrationRun` (Task 6). Rewrite every call site in the same commit — no alias.

`MIGRATIONS_FOLDER` does **not** move as a module constant: Mention's `findMigrationsFolder()` walks up from its own file location, which resolves inside `node_modules` once this is a package. The folder becomes a required argument on `readJournal` and on the runner.

- [ ] **Step 1: Write the failing test**

`packages/db/src/__tests__/ledger.test.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { highWaterMillis, readJournal } from '../migrate/ledger';

function journalFixture(entries: Array<{ tag: string; when: number }>): string {
  const folder = mkdtempSync(join(tmpdir(), 'oxydb-'));
  mkdirSync(join(folder, 'meta'), { recursive: true });
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries })
  );
  return folder;
}

describe('migration ledger', () => {
  it('reads the journal in order', () => {
    const folder = journalFixture([
      { tag: '0000_init', when: 1000 },
      { tag: '0001_next', when: 2000 },
    ]);
    expect(readJournal(folder).map((entry) => entry.tag)).toEqual(['0000_init', '0001_next']);
  });

  it('reports the high-water mark, not the count', () => {
    expect(highWaterMillis([1000, 3000, 2000])).toBe(3000);
  });

  it('reports null when nothing has been applied', () => {
    expect(highWaterMillis([])).toBeNull();
  });
});
```

Match the fixture's journal shape to what Mention's `readJournal` actually parses — read it first; if the file it expects is named differently, the fixture is what changes, never the parser.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: FAIL, `Cannot find module '../migrate/ledger'`.

- [ ] **Step 3: Move both modules**

Copy Mention's `migrationLedger.ts` → `src/migrate/ledger.ts` and `targetDatabase.ts` → `src/migrate/targetDatabase.ts`. Apply the two changes above: `planMigrationRun` → `planLedgerRun`, and `MIGRATIONS_FOLDER` from module constant to argument. Create `src/migrate/index.ts` re-exporting both.

- [ ] **Step 4: Run the tests**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test && bun run --filter @oxyhq/db typescript
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src
git commit -m "feat(db): migration ledger and target-database guard"
```

---

### Task 6: `migrate` — deploy phases

oxy-api's mechanism, which Mention has no counterpart for. It exists because of a real outage: a migration and the code reading its new column merged together, the image reached production and the column did not, and `POST /users/by-ids` returned 500 ecosystem-wide until someone dispatched the migration by hand.

**Files:**
- Create: `OxyHQServices/packages/db/src/migrate/phases.ts`
- Create: `OxyHQServices/packages/db/src/__tests__/phases.test.ts`
- Modify: `OxyHQServices/packages/db/src/migrate/index.ts`
- Source: `OxyHQServices/packages/api/src/db/migrationPhases.ts`

**Interfaces:**
- Consumes: `type JournalEntry` from `./ledger`.
- Produces, from `@oxyhq/db/migrate`: `type DeployPhase = 'pre' | 'post'`, `DEPLOY_PHASES`, `type MigrationRun = 'pre' | 'post' | 'all'`, `MIGRATION_RUNS`, `phaseMarkerLine(phase: DeployPhase): string`, `POST_PHASE_GREP_PATTERN`, `type MigrationPhaseReadResult`, `readMigrationPhases(...)`, `type MigrationRunPlan<T>`, `planMigrationRun<T extends { tag: string }>(...)`.

- [ ] **Step 1: Write the failing test**

`packages/db/src/__tests__/phases.test.ts`:

```ts
import { DEPLOY_PHASES, phaseMarkerLine, planMigrationRun } from '../migrate/phases';

describe('deploy phases', () => {
  it('has exactly two sides of a deploy', () => {
    expect(DEPLOY_PHASES).toEqual(['pre', 'post']);
  });

  it('renders a marker a migration file can carry', () => {
    expect(phaseMarkerLine('pre')).toContain('oxy:deploy-phase=pre');
  });

  it('refuses a pending list where a pre migration sits behind an unapplied post', () => {
    // The ledger records progress as a high-water mark and cannot skip an entry,
    // so this pending list has no half that is correct for either image.
    const pending = [
      { tag: '0009_drop_column', phase: 'post' as const },
      { tag: '0010_add_column', phase: 'pre' as const },
    ];
    expect(() => planMigrationRun(pending, 'pre')).toThrow();
  });
});
```

Read `migrationPhases.ts` before finalising: match `planMigrationRun`'s real parameter shape and whether it throws or returns a refusal, and assert what it actually does.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: FAIL, `Cannot find module '../migrate/phases'`.

- [ ] **Step 3: Move the module**

Copy `packages/api/src/db/migrationPhases.ts` → `packages/db/src/migrate/phases.ts`. Keep `planMigrationRun` under its own name (the ledger's was renamed in Task 5). Re-export from `src/migrate/index.ts`.

- [ ] **Step 4: Run the tests**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src
git commit -m "feat(db): deploy-phase markers and the phased run planner"
```

---

### Task 7: `migrate` — extensions and the runner

**Files:**
- Create: `OxyHQServices/packages/db/src/migrate/extensions.ts`, `src/migrate/runner.ts`
- Create: `OxyHQServices/packages/db/src/__tests__/extensions.test.ts`
- Modify: `OxyHQServices/packages/db/src/migrate/index.ts`
- Sources: `Mention/packages/backend/src/db/extensions.ts`, `Mention/packages/backend/src/db/migrate.ts`, `OxyHQServices/packages/api/src/db/migrate.ts`

**Interfaces:**
- Consumes: `readJournal`, `planLedgerRun`, `assertMigrationTarget`, `readTargetDatabase` from `./ledger` and `./targetDatabase`; `planMigrationRun` from `./phases`.
- Produces, from `@oxyhq/db/migrate`: `type RequiredExtension = { readonly name: string; readonly reason: string }`, `ensureExtensions(databaseUrl: string, extensions: readonly RequiredExtension[]): Promise<void>`, `runMigrations(options: RunMigrationsOptions): Promise<void>`.

**The signature change:** `REQUIRED_EXTENSIONS` does not travel — it names application columns. `ensureExtensions` takes the list. The `EXTENSION_NAME` guard (`/^[a-z][a-z0-9_]*$/`) stays inside, and matters more now that the list is caller-supplied.

- [ ] **Step 1: Write the failing test**

`packages/db/src/__tests__/extensions.test.ts`:

```ts
import { ensureExtensions } from '../migrate/extensions';

describe('ensureExtensions', () => {
  it('refuses a name that is not a bare identifier, before opening a connection', async () => {
    await expect(
      ensureExtensions('postgres://unreachable.invalid/db', [
        { name: 'postgis"; drop database x; --', reason: 'malicious' },
      ])
    ).rejects.toThrow(/must match/);
  });

  it('does nothing at all for an empty list', async () => {
    await expect(
      ensureExtensions('postgres://unreachable.invalid/db', [])
    ).resolves.toBeUndefined();
  });
});
```

The second case is the one that matters for Syra, which requires no extensions: an empty list must not open a connection to a database that may not exist yet. If the current implementation opens the client before checking, move the connection so it is opened lazily — that is a required change, not an optional one.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: FAIL, `Cannot find module '../migrate/extensions'`.

- [ ] **Step 3: Move and re-signature**

Copy Mention's `extensions.ts` → `src/migrate/extensions.ts`, delete the `REQUIRED_EXTENSIONS` const (it stays in Mention), take the list as the second parameter, and open the client only when the list is non-empty. Rewrite the error message: keep the two remedies (a local/CI image that ships the extension; a privileged role running `CREATE EXTENSION` once on a managed database) and drop the Mention-specific file names.

Then write `src/migrate/runner.ts`, combining both repos' `migrate.ts`. Its signature:

```ts
export interface RunMigrationsOptions {
  readonly databaseUrl: string;
  /** Absolute path to the drizzle migrations folder in the CONSUMER's package. */
  readonly migrationsFolder: string;
  readonly extensions: readonly RequiredExtension[];
  /** Which side of the deploy this invocation is. */
  readonly run: MigrationRun;
  /** The database name this URL must point at, from `readTargetDatabase(argv)`. */
  readonly expectedDatabase: string;
  readonly logger: { info(message: string): void; warn(message: string): void };
}

export async function runMigrations(options: RunMigrationsOptions): Promise<void>;
```

Order inside, and it is the whole point of having a runner: `ensureExtensions` → `assertMigrationTarget` → read the journal and the applied high-water mark → `planMigrationRun` for the requested phase → drizzle's `migrate`.

- [ ] **Step 4: Run the tests**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test && bun run --filter @oxyhq/db typescript
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src
git commit -m "feat(db): extension precondition and the phased migration runner"
```

---

### Task 8: `expiry`

**Files:**
- Create: `OxyHQServices/packages/db/src/expiry.ts`
- Create: `OxyHQServices/packages/db/src/__tests__/expiry.test.ts`
- Source: `Mention/packages/backend/src/db/expiry.ts`

**Interfaces:**
- Consumes: `SqlExecutor` from `./database`.
- Produces, from `@oxyhq/db/expiry`: `type ExpirySweepTarget = { table: PgTable; column: PgColumn; retentionSeconds: number; reason: string }`, `type ExpirySweepResult = { table: string; deleted: number; truncated: boolean }`, `type ExpirySweepOptions = { batchSize?: number; maxBatches?: number }`, `sweepExpiredRows(db: SqlExecutor, target: ExpirySweepTarget, options?: ExpirySweepOptions): Promise<ExpirySweepResult>`, `sweepAllExpiredRows(db: SqlExecutor, targets: readonly ExpirySweepTarget[], options?: ExpirySweepOptions): Promise<ExpirySweepResult[]>`.

**Two signature changes:** `sweepAllExpiredRows` takes the targets, and `db` is `SqlExecutor` rather than the app's `Database`. `EXPIRY_SWEEP_TARGETS` stays in each consumer.

- [ ] **Step 1: Write the failing test**

`packages/db/src/__tests__/expiry.test.ts`:

```ts
import { type SQL } from 'drizzle-orm';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { SqlExecutor } from '../database';
import { sweepAllExpiredRows, sweepExpiredRows } from '../expiry';

const events = pgTable('events', {
  id: text().primaryKey(),
  playedAt: timestamp({ withTimezone: true, mode: 'date' }),
});

const target = {
  table: events,
  column: events.playedAt,
  retentionSeconds: 60,
  reason: 'test fixture',
};

/** Returns `perBatch` rows for `batches` calls, then a short batch. */
function executor(perBatch: number, batches: number): SqlExecutor & { statements: SQL[] } {
  const statements: SQL[] = [];
  let remaining = batches;
  return {
    statements,
    execute: async (query: SQL): Promise<Record<string, unknown>[]> => {
      statements.push(query);
      const rows = remaining > 0 ? perBatch : 0;
      remaining -= 1;
      return Array.from({ length: rows }, () => ({ ctid: '(0,1)' }));
    },
  };
}

describe('expiry sweep', () => {
  it('stops as soon as a batch comes back short', async () => {
    const db = executor(10, 2);
    const result = await sweepExpiredRows(db, target, { batchSize: 10, maxBatches: 50 });

    expect(result).toEqual({ table: 'events', deleted: 20, truncated: false });
    expect(db.statements).toHaveLength(3);
  });

  it('reports truncated when the batch ceiling is hit, so a backlog is visible', async () => {
    const db = executor(10, 100);
    const result = await sweepExpiredRows(db, target, { batchSize: 10, maxBatches: 3 });

    expect(result).toEqual({ table: 'events', deleted: 30, truncated: true });
  });

  it('sweeps the targets the CALLER supplies, not a registry of its own', async () => {
    const db = executor(0, 0);
    expect(await sweepAllExpiredRows(db, [])).toEqual([]);
    expect(db.statements).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: FAIL, `Cannot find module '../expiry'`.

- [ ] **Step 3: Move and re-signature**

Copy Mention's `expiry.ts` → `packages/db/src/expiry.ts`, keeping `expiredPredicate`, the `ctid` batching and both defaults. Delete `EXPIRY_SWEEP_TARGETS` and every `./schema/*` import. Change `Database` to `SqlExecutor` and add the `targets` parameter to `sweepAllExpiredRows`.

**The batching call site changes shape.** Mention's sweep reads
`await db.execute<{ ctid: string }>(sql\`…\`)`, and `SqlExecutor.execute` is not
generic — see Task 4. Use `await executeRows<{ ctid: string }>(db, sql\`…\`)`
instead. The row type is what the batch-size comparison depends on, so this is
not cosmetic. Keep the doc comment explaining why the column is interpolated as a drizzle Column and never `sql.identifier(column.name)`.

- [ ] **Step 4: Run the tests**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src
git commit -m "feat(db): TTL-replacement sweep, with the target registry supplied by the caller"
```

---

### Task 9: `testing` — the ephemeral database harness

**Files:**
- Create: `OxyHQServices/packages/db/src/testing.ts`
- Create: `OxyHQServices/packages/db/src/__tests__/testing.test.ts`
- Source: `Mention/packages/backend/src/db/testDatabase.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, from `@oxyhq/db/testing`: `createTestDatabase(options?: { adminUrl?: string }): Promise<string>`, `dropTestDatabase(databaseUrl: string): Promise<void>`.

Mention's version reads its own env var names and `spawn`s its own migration command. Both become options with documented defaults, because Syra's env var and migration command differ.

- [ ] **Step 1: Write the failing test**

`packages/db/src/__tests__/testing.test.ts`. This one is deliberately narrow — the harness needs a real Postgres, which the package's unit suite does not have. Test the part that is pure:

```ts
import { createTestDatabase } from '../testing';

describe('createTestDatabase', () => {
  it('fails loudly when no admin URL is configured, rather than inventing one', async () => {
    await expect(createTestDatabase({ adminUrl: '' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: FAIL, `Cannot find module '../testing'`.

- [ ] **Step 3: Move and parameterise**

Copy Mention's `testDatabase.ts` → `packages/db/src/testing.ts`. Replace every direct `process.env` read and the hardcoded migration `spawn` with options. Keep the random database-name generation and the drop path.

- [ ] **Step 4: Run the tests**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src
git commit -m "feat(db): ephemeral-database harness, with env and migration command as options"
```

---

### Task 10: `assert` — schema invariants

The gates are the highest-leverage part of the extraction: a new consumer inherits the whole convention suite instead of rewriting it. They ship as pure functions returning violations, because the three consumers run three different runners.

**Files:**
- Create: `OxyHQServices/packages/db/src/assert/schemaInvariants.ts`, `src/assert/index.ts`
- Create: `OxyHQServices/packages/db/src/__tests__/schemaInvariants.test.ts`
- Source (to convert, not copy): `OxyHQServices/packages/api/src/db/schema/__tests__/schemaInvariants.test.ts`

**Interfaces:**
- Consumes: `SqlExecutor` from `../database`.
- Produces, from `@oxyhq/db/assert`:

```ts
export interface InvariantViolation {
  /** Which rule was broken, e.g. 'snake_case_column' or 'vacuity'. */
  readonly check: string;
  /** What broke it: 'users.hashedEmail', or a table name, or a count. */
  readonly subject: string;
  readonly detail?: string;
}

export interface SchemaInvariantOptions {
  /** Traversal floor. Fewer tables than this is a broken query, not a clean schema. */
  readonly minimumTables: number;
  readonly minimumColumns: number;
}

export function findSchemaInvariantViolations(
  db: SqlExecutor,
  options: SchemaInvariantOptions
): Promise<InvariantViolation[]>;
```

**The vacuity floor is a violation, not a separate assertion.** Folding it in is what makes a single `expect(violations).toEqual([])` in the consumer safe: a broken catalogue query returns zero rows and would otherwise pass by examining nothing.

Checks, ported one for one from the oxy-api test: `vacuity` (table and column counts below the floors), `snake_case_table`, `snake_case_column`, `timestamp_without_time_zone`, `empty_string_default`, `missing_primary_key`, `mongoose_artifact` (`_id` / `__v`).

- [ ] **Step 1: Write the failing test**

`packages/db/src/__tests__/schemaInvariants.test.ts`. Drive it with a fake executor returning canned `information_schema` rows, so the package's own suite needs no Postgres:

```ts
import type { SQL } from 'drizzle-orm';
import type { SqlExecutor } from '../database';
import { findSchemaInvariantViolations } from '../assert/schemaInvariants';

/** Answers each catalogue query by the fragment of SQL text it contains. */
function catalogue(answers: Array<{ match: string; rows: unknown[] }>): SqlExecutor {
  return {
    execute: async (query: SQL): Promise<Record<string, unknown>[]> => {
      const text = query.queryChunks.map((chunk) => String(chunk)).join(' ');
      const answer = answers.find((candidate) => text.includes(candidate.match));
      return (answer?.rows ?? []) as Record<string, unknown>[];
    },
  };
}

const healthy = [
  { match: 'table_type', rows: Array.from({ length: 30 }, (_, i) => ({ table_name: `t_${i}` })) },
  {
    match: 'information_schema.columns',
    rows: Array.from({ length: 400 }, (_, i) => ({ table_name: 't_0', column_name: `c_${i}` })),
  },
];

describe('findSchemaInvariantViolations', () => {
  it('returns nothing for a healthy schema', async () => {
    const violations = await findSchemaInvariantViolations(catalogue(healthy), {
      minimumTables: 27,
      minimumColumns: 356,
    });
    expect(violations).toEqual([]);
  });

  it('reports a vacuity violation when the traversal finds too few tables', async () => {
    const violations = await findSchemaInvariantViolations(
      catalogue([{ match: 'table_type', rows: [{ table_name: 'only_one' }] }]),
      { minimumTables: 27, minimumColumns: 356 }
    );
    expect(violations.map((v) => v.check)).toContain('vacuity');
  });

  it('names the offending table and column, not just the rule', async () => {
    const violations = await findSchemaInvariantViolations(
      catalogue([
        ...healthy,
        { match: "column_name in ('__v'", rows: [{ table_name: 'posts', column_name: '_id' }] },
      ]),
      { minimumTables: 27, minimumColumns: 356 }
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ check: 'mongoose_artifact', subject: 'posts._id' })
    );
  });
});
```

The `catalogue` fake dispatches on SQL text, so the implementation's query fragments and the test's `match` strings must agree. If a match string stops matching, the fake returns `[]` and the check passes vacuously — mutation-test each one in Step 5.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: FAIL, `Cannot find module '../assert/schemaInvariants'`.

- [ ] **Step 3: Implement**

Convert each `it(...)` in the oxy-api test into a check that pushes `InvariantViolation`s. Keep every SQL query byte-identical to the original — they are already correct, and the point of this task is to change where they live, not what they ask. Create `src/assert/index.ts` exporting the function and both types.

- [ ] **Step 4: Run the tests**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: PASS.

- [ ] **Step 5: Mutation-test each check**

For each of the seven checks, break it in `schemaInvariants.ts` (invert the predicate, or point the query at a non-existent column) and confirm the suite goes red naming that check. Restore in place after each. A check that can be broken with the suite still green is not a gate — fix the test before moving on.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src
git commit -m "feat(db): schema invariants as a runner-agnostic gate"
```

---

### Task 11: `assert` — id-column classification, protected columns, expiry indexes

The remaining three gates, in one task: they share the same shape as Task 10 and a reviewer would accept or reject them together.

**Files:**
- Create: `OxyHQServices/packages/db/src/assert/idColumns.ts`, `src/assert/protectedColumns.ts`, `src/assert/expiryIndexes.ts`
- Create: `OxyHQServices/packages/db/src/__tests__/assertGates.test.ts`
- Modify: `OxyHQServices/packages/db/src/assert/index.ts`
- Sources (to convert): `packages/api/src/db/schema/__tests__/foreignKeys.test.ts`, `packages/api/src/db/schema/__tests__/protectedColumns.test.ts`, `Mention/packages/backend/src/db/__tests__/expiry.test.ts`

**Interfaces:**
- Consumes: `sqlColumnName` from `../casing`; `SqlExecutor` from `../database`; `type ExpirySweepTarget` from `../expiry`.
- Produces, from `@oxyhq/db/assert`:

```ts
export interface DeferredForeignKey {
  readonly table: PgTable;
  readonly column: PgColumn;
  readonly parentTable: string;
  readonly parentColumn: string;
  readonly onDelete: 'cascade' | 'set null' | 'restrict' | 'no action';
  readonly reason: string;
}

export interface IdColumnOptions {
  readonly tables: readonly PgTable[];
  readonly deferred: readonly DeferredForeignKey[];
  /** `*_id` columns that will never carry a constraint, with the reason. */
  readonly withoutForeignKey: readonly { column: string; reason: string }[];
  readonly minimumTables: number;
}

export function findIdColumnViolations(options: IdColumnOptions): InvariantViolation[];

export type ProtectedColumnRegistry = Readonly<Record<string, readonly string[]>>;

export function publicColumns<T extends PgTable>(
  table: T,
  registry: ProtectedColumnRegistry
): Record<string, PgColumn>;

export interface ImplicitReadScanOptions {
  readonly sourceDir: string;
  readonly registry: ProtectedColumnRegistry;
}

export function findImplicitWholeRowReads(
  options: ImplicitReadScanOptions
): Promise<InvariantViolation[]>;

export function findUnsupportedExpiryColumns(
  db: SqlExecutor,
  targets: readonly ExpirySweepTarget[]
): Promise<InvariantViolation[]>;
```

`publicColumns` must exclude at the **type** level, so a serializer reading a protected column fails `tsc` rather than shipping it. Preserve oxy-api's typing approach exactly; if the generic cannot be expressed against a caller-supplied registry, keep the runtime filter and record the type-level gap explicitly in the doc comment rather than papering over it with `as`.

- [ ] **Step 1: Write the failing test**

`packages/db/src/__tests__/assertGates.test.ts`:

```ts
import { pgTable, text } from 'drizzle-orm/pg-core';
import {
  findIdColumnViolations,
  findUnsupportedExpiryColumns,
  publicColumns,
} from '../assert';
import type { SqlExecutor } from '../database';
import type { SQL } from 'drizzle-orm';

const users = pgTable('users', { id: text().primaryKey(), phone: text() });
const posts = pgTable('posts', { id: text().primaryKey(), authorId: text() });
const tables = [users, posts];

describe('findIdColumnViolations', () => {
  it('reports an id-shaped column that is classified nowhere', () => {
    const violations = findIdColumnViolations({
      tables,
      deferred: [],
      withoutForeignKey: [],
      minimumTables: 2,
    });
    expect(violations).toContainEqual(
      expect.objectContaining({ check: 'unclassified_id_column', subject: 'posts.author_id' })
    );
  });

  it('accepts a column declared as never carrying a constraint', () => {
    const violations = findIdColumnViolations({
      tables,
      deferred: [],
      withoutForeignKey: [{ column: 'posts.author_id', reason: 'cross-service id' }],
      minimumTables: 2,
    });
    expect(violations).toEqual([]);
  });

  it('demands a real FK once the parent table is present', () => {
    const violations = findIdColumnViolations({
      tables,
      deferred: [
        {
          table: posts,
          column: posts.authorId,
          parentTable: 'users',
          parentColumn: 'id',
          onDelete: 'cascade',
          reason: 'users landed later',
        },
      ],
      withoutForeignKey: [],
      minimumTables: 2,
    });
    expect(violations).toContainEqual(
      expect.objectContaining({ check: 'deferred_foreign_key_now_owed' })
    );
  });

  it('reports vacuity rather than passing on a broken traversal', () => {
    const violations = findIdColumnViolations({
      tables: [],
      deferred: [],
      withoutForeignKey: [],
      minimumTables: 2,
    });
    expect(violations.map((v) => v.check)).toContain('vacuity');
  });
});

describe('publicColumns', () => {
  it('omits every registered column', () => {
    const selected = publicColumns(users, { users: ['phone'] });
    expect(Object.keys(selected)).toEqual(['id']);
  });

  it('returns every column for a table with no entry', () => {
    expect(Object.keys(publicColumns(posts, { users: ['phone'] }))).toEqual(['id', 'authorId']);
  });
});

describe('findUnsupportedExpiryColumns', () => {
  it('reports a swept column with no supporting btree index', async () => {
    const db: SqlExecutor = { execute: async (_q: SQL): Promise<Record<string, unknown>[]> => [] };
    const violations = await findUnsupportedExpiryColumns(db, [
      { table: posts, column: posts.id, retentionSeconds: 60, reason: 'fixture' },
    ]);
    expect(violations).toContainEqual(
      expect.objectContaining({ check: 'expiry_column_without_index', subject: 'posts.id' })
    );
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test
```

Expected: FAIL, `Cannot find module '../assert'` exports.

- [ ] **Step 3: Implement the three modules**

Convert each source test into pure functions, keeping the SQL and the traversal logic identical. Two details that are easy to lose and are the reason these gates work:

- Use `sqlColumnName(column)`, never `column.name`. The latter is the TypeScript property, so an `endsWith('_id')` test against it matches nothing and passes vacuously.
- The implicit-read scanner looks for a bare `select()` and the relational `db.query.<table>` API against any table in the registry, and reports `file:line`.

- [ ] **Step 4: Run the tests**

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db test && bun run --filter @oxyhq/db typescript
```

Expected: PASS.

- [ ] **Step 5: Mutation-test the scanner specifically**

Add a file under a temporary directory containing `db.select().from(users)`, run `findImplicitWholeRowReads` against it, and confirm it is reported with the right `file:line`. Then change it to a named select and confirm it is not. A scanner that cannot tell those apart is the exact failure this gate exists to prevent.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src
git commit -m "feat(db): id-column, protected-column and expiry-index gates"
```

---

### Task 12: Migrate oxy-api onto the package

First consumer, in-repo via `workspace:*`, so the API surface is proven before anything is published.

**Files:**
- Modify: `OxyHQServices/packages/api/package.json` (add `"@oxyhq/db": "workspace:^"`)
- Delete: `packages/api/src/db/casing.ts`, `pgErrors.ts`, `extensions.ts`, `migrate.ts`, `migrationLedger.ts`, `migrationPhases.ts`, `expiry.ts`; the generic exports in `packages/api/src/db/schema/columns.ts`
- Modify: 141 import sites — casing 17, pgErrors 10, expiry 6, extensions 3, migrationLedger 5, migrationPhases 2, columns 98
- Modify: `packages/api/src/db/schema/__tests__/schemaInvariants.test.ts`, `foreignKeys.test.ts`, `protectedColumns.test.ts`, `db/__tests__/expiry.test.ts` — these four DO change, because their bodies moved into the package; they become thin callers of the gate functions
- Modify: `packages/api/drizzle.config.ts`, `packages/api/scripts/check-migration-phases.mjs`

**Interfaces:**
- Consumes: everything produced by Tasks 1–11.
- Produces: nothing new.

- [ ] **Step 1: Record the green baseline BEFORE touching anything**

```bash
cd /home/nate/Oxy/OxyHQServices/packages/api && bun run test 2>&1 | tail -20
```

Write the pass/fail counts down. A non-green baseline means the tree is stale, not that the code is broken — reinstall and re-run before proceeding. Every later claim in this task is measured against these numbers.

- [ ] **Step 2: Add the dependency**

```bash
cd /home/nate/Oxy/OxyHQServices && bun add --cwd packages/api @oxyhq/db@workspace:^ && bun install
```

- [ ] **Step 3: Rewrite the imports, module by module**

Do them one module at a time, running the suite after each — a 141-site rewrite in one step gives a failure with no bisect. Order: `casing` (17), `pgErrors` (10), `migrationPhases` (2), `migrationLedger` (5), `extensions` (3), `expiry` (6), `columns` (98).

For each: rewrite the import, delete the local module, and confirm nothing still references it:

```bash
cd /home/nate/Oxy/OxyHQServices/packages/api && grep -rn "db/casing'" src scripts | wc -l
```

Expected after each module: `0`.

The `columns` rewrite is the large one, and it is a **split**, not a move: `packages/api/src/db/schema/columns.ts` keeps whatever is genuinely oxy-api's and re-imports the shared helpers from `@oxyhq/db`. Do not leave it re-exporting them — that is the barrel shim the standing rules forbid; each of the 98 sites imports from `@oxyhq/db` directly.

- [ ] **Step 4: Convert the four gate tests to thin callers**

`schemaInvariants.test.ts` becomes, in full:

```ts
import { findSchemaInvariantViolations } from '@oxyhq/db/assert';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';

/** Tables landed so far. A traversal returning fewer than this is broken. */
const MINIMUM_TABLES = 27;
/** Columns across those tables. Same purpose. */
const MINIMUM_COLUMNS = 356;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

it('holds every schema invariant', async () => {
  const violations = await findSchemaInvariantViolations(getDb(), {
    minimumTables: MINIMUM_TABLES,
    minimumColumns: MINIMUM_COLUMNS,
  });

  expect(violations).toEqual([]);
});
```

Do the same for the other three. The floors and the registries stay in oxy-api — they are its data.

- [ ] **Step 5: Point the migration entry points at the runner**

Rewrite `packages/api/src/db/migrate.ts` to call `runMigrations` from `@oxyhq/db/migrate`, passing its own `REQUIRED_EXTENSIONS`, its migrations folder resolved from its own package root, and the phase from `--phase`. Update `scripts/check-migration-phases.mjs` to import the phase helpers from the package.

- [ ] **Step 6: Run everything**

```bash
cd /home/nate/Oxy/OxyHQServices/packages/api && bun run test && bun run build
```

Expected: the same pass/fail counts as Step 1, with only the four gate test FILES changed. If any other test needed editing, stop — that is a behaviour change and the extraction is wrong somewhere.

- [ ] **Step 7: Verify the migration path against a real database**

```bash
cd /home/nate/Oxy/OxyHQServices/packages/api && bun run db:migrate
```

Against a local Postgres, from an empty database. Expected: extensions ensured, target asserted, every migration applied, exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/api packages/db bun.lock
git commit -m "refactor(api): consume @oxyhq/db instead of a local copy of the plumbing"
```

---

### Task 13: Publish `@oxyhq/db@0.1.0`

**Files:**
- Modify: `OxyHQServices/packages/db/package.json` (version, if it moved during development)

- [ ] **Step 1: Confirm main is current and the tree is clean**

```bash
cd /home/nate/Oxy/OxyHQServices && git status --porcelain && git log --oneline -1 && git fetch origin && git status -sb | head -1
```

Expected: clean tree, local `main` not behind `origin/main`. **Never publish from uncommitted state** — a publish that does not match the committed release burns the version number permanently.

- [ ] **Step 2: Pack and inspect the tarball**

```bash
cd /home/nate/Oxy/OxyHQServices/packages/db && bun run clean && bun run build && bun pm pack
tar -xzOf oxyhq-db-0.1.0.tgz package/package.json | head -60
```

Expected: `peerDependencies` naming `drizzle-orm` and `postgres` with the ranges from the constraints section, and **no literal `workspace:`** anywhere. `bun pm pack` substitutes it; `npm pack` does not, and a manifest shipping `workspace:^` is installable by nobody.

- [ ] **Step 3: Verify the tarball's contents include what every subpath export points at**

```bash
tar -tzf oxyhq-db-0.1.0.tgz | grep -E "dist/(esm|cjs|types)/(index|migrate/index|expiry|testing|assert/index)" | sort
```

Expected: 15 paths — five subpaths across three build outputs. A missing one is an export that 404s on install.

- [ ] **Step 4: Publish**

```bash
cd /home/nate/Oxy/OxyHQServices/packages/db && bun publish
```

- [ ] **Step 5: Verify propagation with a clean external install**

```bash
SP=$(mktemp -d) && cd "$SP" && bun init -y >/dev/null && bun add @oxyhq/db@0.1.0 drizzle-orm@0.45.2 postgres@3.4.9 && node -e "
  Promise.all([import('@oxyhq/db'), import('@oxyhq/db/migrate'), import('@oxyhq/db/expiry'), import('@oxyhq/db/testing'), import('@oxyhq/db/assert')])
    .then(mods => console.log(mods.map(m => Object.keys(m).length)))
"
```

Expected: five non-zero counts. Outside the monorepo, so nothing resolves through the workspace.

---

### Task 14: Migrate Mention onto the package

The real test of the package boundary: a separate repo cannot reach into the monorepo for anything the package forgot to export.

**Files:**
- Modify: `Mention/packages/backend/package.json` (add `@oxyhq/db`)
- Delete: `packages/backend/src/db/casing.ts`, `pgErrors.ts`, `extensions.ts` (mechanism), `migrate.ts`, `migrationLedger.ts`, `expiry.ts` (mechanism), `targetDatabase.ts`, `testDatabase.ts`, `ids.ts`; the generic half of `schema/columns.ts`
- Modify: 114 import sites — casing 19, pgErrors 28, expiry 2, extensions 1, migrationLedger 3, targetDatabase 4, testDatabase 1, ids 5, columns 51
- Modify: `packages/backend/src/db/postgres.ts` (build the handle through `createDatabase`)

**Interfaces:**
- Consumes: `@oxyhq/db@0.1.0` from npm.
- Produces: nothing new.

- [ ] **Step 1: Record the green baseline**

```bash
cd /home/nate/Oxy/Mention/packages/backend && bun run test 2>&1 | tail -20
```

Write the counts down. Same rule as Task 12: a non-green baseline is a stale tree, not broken code.

- [ ] **Step 2: Install the published package**

```bash
cd /home/nate/Oxy/Mention && bun add --cwd packages/backend @oxyhq/db@^0.1.0 && bun install
```

Confirm it resolved to the published tarball and not to anything local:

```bash
cd /home/nate/Oxy/Mention && cat node_modules/@oxyhq/db/package.json | grep '"version"'
```

- [ ] **Step 3: Rewrite the imports, module by module**

Same order and same discipline as Task 12: one module, run the suite, confirm zero remaining references, next module.

Mention's `EXPIRY_SWEEP_TARGETS` and `REQUIRED_EXTENSIONS` stay in `packages/backend/src/db/`, now typed by the package's `ExpirySweepTarget` and `RequiredExtension`, and passed in at the call sites.

- [ ] **Step 4: Rebuild the database handle through the factory**

`packages/backend/src/db/postgres.ts` keeps `connectPostgres`, `getDb`, `getPostgresClient`, `isPostgresConnected`, `checkPostgresHealth` and `closePostgres` — the singleton and its lifecycle are Mention's. Only the construction changes to `createDatabase({ url, schema })`, which is what guarantees the handle is built with `DATABASE_CASING`.

- [ ] **Step 5: Run everything**

```bash
cd /home/nate/Oxy/Mention/packages/backend && bun run test && bun run build
```

Expected: the same counts as Step 1, with the gate test files the only ones edited.

- [ ] **Step 6: Verify the migration path against a real database**

```bash
cd /home/nate/Oxy/Mention/packages/backend && bun run db:migrate
```

Against a local `postgis/postgis:17-3.5` container, from an empty database. PostGIS must be created by a privileged role first — `ensureExtensions` short-circuits on the duplicate check before the privilege check, so it is a no-op on a prepared database and a hard failure on an unprepared one.

- [ ] **Step 7: Commit**

```bash
cd /home/nate/Oxy/Mention && git add packages/backend bun.lock
git commit -m "refactor(backend): consume @oxyhq/db instead of a local copy of the plumbing"
```

---

### Task 15: The mutation gate

The extraction's whole claim is that one implementation now serves three consumers. This task tests that claim rather than asserting it.

**Files:** none created; this is a verification task whose output is a written finding.

- [ ] **Step 1: Break a helper and confirm both consumers see it**

In `packages/db/src/casing.ts`, change `sqlColumnName` to return `column.name` (the TypeScript property) instead of the cased name. Rebuild the package, then run both suites:

```bash
cd /home/nate/Oxy/OxyHQServices && bun run --filter @oxyhq/db build && cd packages/api && bun run test 2>&1 | tail -5
```

Expected: RED, naming a query that referenced a column that does not exist.

- [ ] **Step 2: Restore in place and verify byte-identical**

```bash
cd /home/nate/Oxy/OxyHQServices && git checkout packages/db/src/casing.ts && git status --porcelain packages/db && bun run --filter @oxyhq/db build
```

Expected: no output from `git status`. `node_modules` is hardlinked and shared machine-wide — never leave a mutation live.

- [ ] **Step 3: Repeat for one gate and one predicate**

Break `isUniqueViolation` (make it always return `false`) and confirm a consumer test that relies on catching a duplicate goes red. Break one check in `findSchemaInvariantViolations` and confirm the consumer's gate test goes red naming that check. Restore both in place.

**A helper that can be broken with every consumer still green is either dead or untested.** Record which, and resolve it before closing this task — do not report the extraction complete with an unmeasured helper in it.

- [ ] **Step 4: Write the findings**

Append a short section to the spec recording: which helpers were mutation-tested, which consumers detected each, and any helper that no consumer test covers. A stated gap is worth more than a confident summary.

- [ ] **Step 5: Commit**

```bash
cd /home/nate/Oxy/Syra && git add docs/superpowers/specs
git commit -m "docs(specs): record the @oxyhq/db mutation-gate findings"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: the module table → Tasks 1–9; the assert helpers → Tasks 10–11; the `createDatabase` factory and the "what does not move" rule → Task 4; consumer order → Tasks 12, 14; publish discipline → Task 13; the mutation and no-test-edited verification → Tasks 12 Step 6, 14 Step 5, and 15.

**Two spec items that are handled but easy to miss when executing:**
- The `createdAt` precision change is Task 3 only, and it is the single sanctioned behaviour change. If it surfaces in any other task, something is wrong.
- The `planMigrationRun` collision is resolved in Task 5 (ledger's → `planLedgerRun`) and consumed in Task 6. An executor doing Task 6 first will find the collision unresolved.

**Known gap, stated rather than hidden.** Task 11's `publicColumns` must exclude at the type level against a **caller-supplied** registry, which is a harder generic than oxy-api's version (whose registry is a module constant it can read at compile time). If the type-level exclusion cannot be preserved, the runtime filter plus the implicit-read scanner still hold the line, but the `tsc`-fails-on-a-leak property weakens to a test-fails-on-a-leak property. That trade is the reviewer's call, not the implementer's — raise it rather than deciding it silently.

**Order dependency worth stating.** Task 12 must not start before Task 11 is green: oxy-api's four gate tests have nowhere to move their bodies to until all four gate modules exist.
