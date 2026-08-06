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
function findMigrationsFolder(): string {
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

main().catch((error: unknown) => {
  logger.error('Postgres migration failed', error);
  // Not `process.exit`: the pino transport used in development writes from a
  // worker thread, and exiting here would truncate the very message that says
  // what went wrong. The event loop is already free once the pool is closed.
  process.exitCode = 1;
});
