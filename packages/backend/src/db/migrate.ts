/**
 * Apply the SQL migrations in `drizzle/` to `DATABASE_URL`.
 *
 * This is the ONE migration mechanism for the Postgres side of this package.
 * `bun run db:migrate` runs it; nothing else applies a migration by any other
 * route. The actual apply — journal read, ledger read, phase planning,
 * extension setup, `migrate()`, the post-apply re-check — is `runMigrations`
 * from `@oxyhq/db/migrate`; see its own doc comment for the full ordering and
 * why each step comes where it does. This file supplies everything that
 * mechanism needs from THIS package: its migrations folder, its required
 * extensions (`REQUIRED_EXTENSIONS`, empty today), its `--phase` argument and
 * its `--target-database` guard.
 *
 * `--phase` IS REQUIRED, and says which side of a deployment this run stands
 * on. `@oxyhq/db/migrate`'s `phases.ts` explains the marker each migration
 * carries and the incident that put it there; the short version:
 *
 *   --phase=pre    the PREVIOUS image is still serving. Applies additive
 *                  migrations only, and stops at the first destructive one.
 *   --phase=post   the NEW image is live. Applies what `pre` deferred.
 *   --phase=all    nothing to protect — a developer's database, this task's
 *                  own first migration against `syra_dev`. Applies everything
 *                  pending.
 *
 * There is no default. A run that does not say which side it is on would have
 * to guess, and guessing "pre" silently strands a drop while guessing "all"
 * silently runs one against a live previous image.
 *
 * THE GENESIS BOOTSTRAP WINDOW — `LAST_GENESIS_MIGRATION_TAG`
 *
 * `0000` through `0008` build this schema against an EMPTY database with no
 * live predecessor to protect — Tasks 1 through 4 of the Mongo→Postgres port,
 * plus the Task 4 review's `0007`/`0008` genres-`kind` follow-up, applied so
 * far only with `--phase=all` against `syra_dev` and CI's `syra_ci`. A
 * `pre`/`post` review of an earlier cut of this window (Task 4 code review,
 * `task-4-review.md`, Critical #1) found it does NOT actually satisfy
 * `planMigrationRun`'s ordering invariant: `0003` (Task 3, `pre`) sits behind
 * `0001`/`0002` (Task 2, `post`), so `--phase=pre` and `--phase=post` both
 * BLOCK if run against this window — only `--phase=all` succeeds.
 *
 * The ruling: do not re-order or re-mark history to force the invariant to
 * hold retroactively. There is nothing a phase split protects yet — no image
 * is currently serving against this schema, so `pre` sequenced ahead of
 * `post` buys a real image nothing it does not already have by applying
 * everything at once. `--phase=all` is not a workaround for this window, it
 * is the CORRECT and ONLY sanctioned way to apply it, and this is where that
 * gets written down rather than left as tribal knowledge.
 *
 * THE BOUNDARY IS NOT A FIXED RANGE — IT ADVANCES, THEN FREEZES. The honest
 * definition of "genesis" is not "the migrations Task 1-4 happened to write"
 * but "ran, and will only ever run, against an empty database": every
 * migration that lands BEFORE Syra's first production Postgres deploy
 * qualifies, because no image is live yet for a `pre`/`post` split to
 * protect. So `LAST_GENESIS_MIGRATION_TAG` moves forward with each such
 * migration — this is routine maintenance, not a per-migration judgment call
 * — and FREEZES permanently the moment that first production deploy happens.
 * From that point on a real image is serving against this schema, and every
 * migration after the frozen boundary is a real rollout the `pre`/`post`
 * invariant has to hold for. Concretely: the boundary was set at `0005` when
 * this comment was first written and then left there while `0006`-`0008`
 * landed against it the exact same way `0000`-`0005` did — against nothing
 * yet deployed — which is the value never having been advanced, not evidence
 * those three needed a `pre`/`post` split. The Task 4 review that added this
 * paragraph is what actually moves it, to `0008`, catching all three up at
 * once.
 *
 * `0008` is also why the boundary matters for more than ordering: its
 * composite `(genre_id, kind) -> genres(id, kind)` FK is safe to add ONLY
 * because `genres`, `album_genres`, and `podcast_categories` are empty going
 * in — see `0008`'s own header. A migration with that property is exactly
 * what "genesis" is for; it would not be safe to run the same way against a
 * database a live image had already been writing to, which is precisely the
 * case the boundary stops applying to once it freezes.
 *
 * `LAST_GENESIS_MIGRATION_TAG`, below, draws the (currently still moving)
 * line: every migration up to and including it is genesis (unordered,
 * `--phase=all` only). Every migration AFTER it is a REAL rollout against a
 * database with a live predecessor, and for those,
 * `src/db/__tests__/gates.test.ts`'s "deploy-phase ordering (post-genesis)"
 * describe block enforces the invariant this window itself does not satisfy:
 * no `pre` migration may be ordered behind a `post` one. That is what makes
 * `--phase=pre`/`--phase=post` trustworthy the first time a real rollout
 * actually needs them.
 *
 * A COROLLARY FOR EVERY MIGRATION AFTER THE BOUNDARY: keep additive DDL and
 * narrowing DDL in SEPARATE migration files. `drizzle-kit generate` will
 * happily emit one file mixing both — and because ONE narrowing statement
 * forces the whole file `post` (`@oxyhq/db/migrate`'s own per-file rule, and
 * the correct one), a single trailing `ADD CONSTRAINT`/`DROP COLUMN` in an
 * otherwise-additive generated file drags every purely-additive statement in
 * it onto the `post` side too — exactly what happened to Task 4's own `0004`
 * (ten additive `CREATE TABLE`s, `post`-tagged solely because of one trailing
 * `ADD CONSTRAINT`). That is safe only inside the genesis window; after the
 * boundary it means tables a rollout needs get created AFTER the image that
 * needs them is already live. `drizzle-kit` will not split a generated file
 * for you — if a schema change needs both an additive and a narrowing
 * statement, generate it once, then hand-split the SQL into two files with
 * their own tags and their own correct phase markers before either is
 * applied.
 *
 * `--target-database=<name>` IS ALSO REQUIRED, checked against
 * `current_database()` before any other statement on the connection. Unlike
 * oxy-api — which omits `runMigrations`'s `expectedDatabase` option because it
 * has a legacy invocation (a bare `db:migrate` script, a jest harness, two
 * production deploy paths) that adopting it would have to change all at once
 * — Syra has no existing invocation to preserve. Every caller of this file
 * starts having to name the database it believes it is migrating, so the
 * wrong-database guard (`@oxyhq/db/migrate`'s `targetDatabase.ts`) costs
 * nothing to adopt on day one.
 *
 * WHY NOT `drizzle-kit migrate`
 *
 * drizzle-kit is a CLI dependency this package keeps as a devDependency only,
 * for `db:generate` — which never opens a database and only ever runs on a
 * developer's machine. `drizzle-orm` — already a runtime dependency — ships
 * the migrator itself (what `runMigrations` drives), so the migrator compiles
 * into the SAME image the service runs and adds no dependency at all.
 *
 * BOTH TOOLS SHARE ONE LEDGER. `drizzle-kit migrate` and `drizzle-orm`'s
 * `migrate()` read the same `meta/_journal.json`, write the same
 * `drizzle.__drizzle_migrations` rows, and apply the same "everything newer
 * than the newest recorded `created_at`" rule — so a database migrated by
 * either is understood by the other.
 *
 * NO LOCK OF ITS OWN. `runMigrations` takes no lock against a second
 * concurrent migrator — see its own doc comment for why. Nothing today
 * invokes this file from two places at once (there is no deploy-time
 * migration wiring yet), so there is no interlock to add here yet either. A
 * caller that gains a concurrent invocation path (a deploy step racing a
 * manual dispatch, the way oxy-api's `src/db/migrate.ts` does) should take a
 * session-scoped Postgres advisory lock on a connection it owns for its own
 * lifetime, the same way that file does — not something this module can
 * provide for a caller that does not exist yet.
 *
 * DRY RUN. `DRY_RUN=true` reports which migrations WOULD be applied and
 * writes nothing — not even the ledger table.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type MigrationRun, MIGRATION_RUNS, readTargetDatabase, runMigrations } from '@oxyhq/db/migrate';
import { logger } from '../utils/logger';
import { REQUIRED_EXTENSIONS } from './extensions';

/** How far above this module `drizzle/` may sit before the search gives up. */
const MIGRATIONS_SEARCH_DEPTH = 6;

/**
 * The journal tag of the last GENESIS migration — see this file's own doc
 * comment, "THE GENESIS BOOTSTRAP WINDOW", for what that means, why the line
 * moves rather than sits fixed, and why it freezes for good at Syra's first
 * production Postgres deploy (has not happened yet). Every migration up to
 * and including this one is exempt from the pre-behind-post ordering
 * invariant; every migration after it is held to it by `gates.test.ts`'s
 * "deploy-phase ordering (post-genesis)" describe block.
 *
 * Exported so that gate can read the SAME boundary this file documents,
 * rather than a second copy of the tag string that could drift from it.
 */
export const LAST_GENESIS_MIGRATION_TAG = '0008_stiff_the_liberteens';

/**
 * `packages/backend/drizzle`, found by walking UP from this module rather than
 * by a fixed relative path or the working directory.
 *
 * A fixed path cannot be right in both places this file runs from. Under
 * `bun run db:migrate` and the test suite it loads from `<pkg>/src/db`, two
 * levels below the package root; the compiled form (`tsconfig.json` sets
 * `rootDir: "./"`, so `src/` is preserved inside `dist/`) loads from
 * `<pkg>/dist/src/db`. A fixed `'..','..'` is correct in source and silently
 * resolves to `<pkg>/dist/drizzle` — which does not exist — once compiled.
 *
 * Silently is the operative word: `migrate()` against a missing folder applies
 * NOTHING and reports success, which is exactly the "clean run that migrated
 * nothing" failure `readJournal` (`@oxyhq/db/migrate`) exists to refuse. So the
 * search targets the journal itself and throws, naming every directory it
 * looked in, when it cannot find one.
 */
export function findMigrationsFolder(): string {
  const attempted: string[] = [];
  let directory = __dirname;
  for (let depth = 0; depth < MIGRATIONS_SEARCH_DEPTH; depth += 1) {
    const candidate = join(directory, 'drizzle');
    attempted.push(candidate);
    if (existsSync(join(candidate, 'meta', '_journal.json'))) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    'Cannot locate the drizzle/ migrations directory. Looked in:\n' +
    `${attempted.map((path) => `  ${path}`).join('\n')}\n` +
    'It must ship next to the compiled migrator.'
  );
}

/** Whether `DRY_RUN` asks for a report instead of an apply. */
function isDryRun(): boolean {
  const value = (process.env.DRY_RUN ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/** The `--phase=<run>` argument. */
function readRun(argv: readonly string[]): MigrationRun {
  const flags = argv.filter((argument) => argument.startsWith('--phase='));

  if (flags.length === 0) {
    throw new Error(
      `--phase is required. Use one of: ${MIGRATION_RUNS.map((run) => `--phase=${run}`).join(', ')}. ` +
      '`--phase=all` is the right answer for a developer database or a manual dispatch.'
    );
  }
  if (flags.length > 1) {
    throw new Error(`--phase was given ${flags.length} times: ${flags.join(' ')}.`);
  }

  const value = flags[0].slice('--phase='.length);
  if (!(MIGRATION_RUNS as readonly string[]).includes(value)) {
    throw new Error(`Unrecognised --phase=${value}. Use one of: ${MIGRATION_RUNS.join(', ')}.`);
  }
  return value as MigrationRun;
}

async function main(): Promise<void> {
  // Argument validation first, and before DATABASE_URL: it is the cheapest and
  // most local failure, and it means a broken invocation is caught before
  // anything opens a socket.
  const run = readRun(process.argv.slice(2));
  const expectedDatabase = readTargetDatabase(process.argv.slice(2));

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Start a local Postgres with: ' +
      'docker compose -f docker-compose.postgres.yml up -d postgres'
    );
  }

  await runMigrations({
    databaseUrl: url,
    migrationsFolder: findMigrationsFolder(),
    extensions: REQUIRED_EXTENSIONS,
    run,
    expectedDatabase,
    dryRun: isDryRun(),
    logger,
  });
}

// `require.main === module`, not a bare top-level call: this module is now
// also IMPORTED (`findMigrationsFolder`, `LAST_GENESIS_MIGRATION_TAG` — see
// `gates.test.ts`'s "deploy-phase ordering (post-genesis)" describe block),
// and a bare `main().catch(...)` at module scope ran on every such import,
// including under `bun test`, where there is no `--phase` argument to read.
// It failed loudly (logged as an ERROR) and, worse, silently set
// `process.exitCode = 1` on an otherwise fully green test run — a passing
// suite reporting failure to CI. Guard so the script only runs when this
// file is the entry point, i.e. `bun run src/db/migrate.ts` / `bun run
// db:migrate`, never when it is imported. `import.meta.main` (Bun's own
// entry-point flag) is not usable here — `package.json`'s `"type":
// "commonjs"` makes tsc reject `import.meta` in this file outright
// (`TS1470`) — so this uses the CommonJS-native equivalent instead, which
// this file's compiled output actually is.
if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('Postgres migration failed', error);
    // Not `process.exit`: the pino transport used in development writes from
    // a worker thread, and exiting here would truncate the very message that
    // says what went wrong. The event loop is already free once the pool is
    // closed.
    process.exitCode = 1;
  });
}
