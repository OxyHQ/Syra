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
 *   --phase=all    nothing to protect — a developer's `syra_dev`, CI's
 *                  `syra_ci`. Applies everything pending. Since the 2026-08-08
 *                  cutover it is no longer correct for production, which now
 *                  has a live image to stage around.
 *
 * There is no default. A run that does not say which side it is on would have
 * to guess, and guessing "pre" silently strands a drop while guessing "all"
 * silently runs one against a live previous image.
 *
 * THE GENESIS BOOTSTRAP WINDOW — `LAST_GENESIS_MIGRATION_TAG`
 *
 * `0000` through `0011` build this schema against an EMPTY database with no
 * live predecessor to protect — Tasks 1 through 6 of the Mongo→Postgres port,
 * including the Task 4 review's `0007`/`0008` genres-`kind` follow-up, Task
 * 5's `0009`/`0010` creators-and-uploads pair and Task 6's `0011` rooms
 * vertical, applied with `--phase=all` against `syra_dev`, CI's `syra_ci` and —
 * on 2026-08-08, once the window closed at `0024` — production. A
 * `pre`/`post` review of an earlier cut of this window (Task 4 code review,
 * `task-4-review.md`, Critical #1) found it does NOT actually satisfy
 * `planMigrationRun`'s ordering invariant: `0003` (Task 3, `pre`) sits behind
 * `0001`/`0002` (Task 2, `post`), so `--phase=pre` and `--phase=post` both
 * BLOCK if run against this window — only `--phase=all` succeeds.
 *
 * The ruling: do not re-order or re-mark history to force the invariant to
 * hold retroactively. There was nothing a phase split protected — no image was
 * serving against this schema, so `pre` sequenced ahead of `post` would have
 * bought a real image nothing it did not already get by applying everything at
 * once. `--phase=all` was not a workaround for this window, it was the CORRECT
 * and ONLY sanctioned way to apply it, and this is where that got written down
 * rather than left as tribal knowledge. It is also what the cutover actually
 * ran, and the reason the ruling still stands unedited: re-marking `0000`-`0024`
 * now would rewrite the phases of migrations production has already applied.
 *
 * THE BOUNDARY ADVANCED, AND IS NOW FROZEN — SEE "THE WINDOW IS CLOSED"
 * BELOW. The honest definition of "genesis" is not "the migrations Task 1-4
 * happened to write" but "ran, and will only ever run, against an empty
 * database": every migration that landed BEFORE Syra's first production
 * Postgres deploy qualifies, because no image was live yet for a `pre`/`post`
 * split to protect. So `LAST_GENESIS_MIGRATION_TAG` moved forward with each
 * such migration — routine maintenance, not a per-migration judgment call —
 * until that first production deploy, at which point it froze permanently.
 * From that point on a real image is serving against this schema, and every
 * migration after the frozen boundary is a real rollout the `pre`/`post`
 * invariant has to hold for. Concretely: the boundary was set at `0005` when
 * this comment was first written and then left there while `0006`-`0008`
 * landed against it the exact same way `0000`-`0005` did — against nothing
 * yet deployed — which is the value never having been advanced, not evidence
 * those three needed a `pre`/`post` split. The Task 4 review that added this
 * paragraph is what actually moves it, to `0008`, catching all three up at
 * once. Task 5 moved it again, to `0010`, Task 6 to `0011` (then `0013` with
 * its review pair), and Task 7 to `0015` (`0014` plus its own review
 * follow-up), for the same reason and by the same rule — routine maintenance, not a judgment call, for as long as nothing is
 * deployed. Task 10b moves it to `0018`, catching up THREE at once — `0016`
 * (Task 10a's `tracks_album_id_idx`), `0017` and `0018` — because 10a landed
 * a migration without advancing the boundary and 10b landed two more. That
 * is the same "the value was never advanced" lapse the `0006`-`0008` sentence
 * above describes, recurring one task later, which is worth noting: this is
 * routine maintenance that is routinely forgotten, and nothing fails when it
 * is. The post-genesis ordering gate simply holds three migrations to an
 * invariant that has nothing to protect, so the failure is silent in the safe
 * direction — which is exactly why it kept happening.
 *
 * THE WINDOW IS CLOSED. Syra cut over to Postgres in production on 2026-08-08:
 * all 25 genesis migrations, `0000` through `0024`, were applied with
 * `--phase=all` against the production database, and the image serving against
 * them is live. So the boundary has taken its final value and
 * `LAST_GENESIS_MIGRATION_TAG` is FROZEN at `0024_ambitious_xorn` — the last
 * migration that ran against a database no image was reading. It must never be
 * advanced again, for the reason spelled out on the constant itself: advancing
 * it does not relax the ordering rule, it DELETES it, silently and with every
 * test green.
 *
 * `0025` onwards are real rollouts. `--phase=pre` runs while the previous image
 * is still serving and `--phase=post` once the new one is live, both for real
 * now rather than as a rehearsal — and the corollary below about keeping
 * additive DDL apart from narrowing DDL stops being advice and becomes the
 * thing that keeps a deploy from stranding a drop. `--phase=all` remains
 * correct for a developer database and for CI, neither of which has a live
 * predecessor; it is no longer correct for production.
 *
 * `0011` is, notably, the FIRST migration in this window that would have been
 * correct outside it too: it is purely additive (eight new tables, their own
 * foreign keys, their own indexes — no statement touches a pre-existing
 * table), so it is legitimately `pre` on its own merits rather than by the
 * window's exemption. See its own header. `0014` (Task 7) is the second: ten
 * new tables plus five foreign keys, all of them declared BY those new tables,
 * so nothing a live image writes could be rejected by any statement in it.
 * Its review follow-up `0015` is the counter-example in the same task: two
 * `DROP CONSTRAINT` + `ADD CONSTRAINT` pairs, `post` on the STATEMENT's shape
 * even though the re-added expression is semantically identical to the dropped
 * one. Phasing on the shape rather than on a per-case reading of the semantics
 * is what keeps the rule mechanical.
 *
 * `0012`/`0013` (Task 6 review round 1) are the first pair to demonstrate the
 * COROLLARY below rather than violate it. One `drizzle-kit generate` run
 * emitted a single file mixing two `CREATE INDEX`es with two `ADD CONSTRAINT`
 * CHECKs; because a file is phased as a whole, that would have dragged both
 * additive statements onto the `post` side exactly as happened to `0004`. They
 * were split by RE-GENERATING in two steps — indexes first, then constraints —
 * so each file carries its own correct snapshot and journal entry instead of a
 * hand-patched one, and they are ordered `pre` then `post`. That ordering
 * satisfies `planMigrationRun`'s invariant on its own merits, which the
 * `0000`-`0005` stretch of this window does not.
 *
 * `0022`/`0023` (Task 13a, the `track_keys` split) are the second such pair,
 * regenerated the same way — the intermediate schema declares the two new
 * columns and still carries `kind`, so `0022` diffs to the additive half and
 * `0023` to the narrowing half, each with its own snapshot. They are also the
 * first pair where the split runs through the DATA change rather than only the
 * DDL: copying `track_id` into the arm its `kind` names is additive and sits in
 * `0022`, while clearing `track_id` on the two foreign arms is what would break
 * an image still reading that column, so it opens `0023`. Both halves are
 * defensive — nothing has ever written a row — and both files say so.
 *
 * `0008` is also why the boundary matters for more than ordering: its
 * composite `(genre_id, kind) -> genres(id, kind)` FK is safe to add ONLY
 * because `genres`, `album_genres`, and `podcast_categories` are empty going
 * in — see `0008`'s own header. `0010` (the `tracks.copyright_report_id`
 * foreign key the deferred ledger had been holding since Task 2) has exactly
 * the same property for exactly the same reason: `ADD CONSTRAINT ... FOREIGN
 * KEY` verifies every existing row, which is free on an empty table and a
 * lock plus a possible outright failure on a populated one. A migration with
 * that property is exactly what "genesis" is for; it would not be safe to run
 * the same way against a database a live image had already been writing to,
 * which is precisely the case the boundary stopped applying to when it froze.
 *
 * `LAST_GENESIS_MIGRATION_TAG`, below, draws the (now fixed) line: every
 * migration up to and including it is genesis (unordered, `--phase=all` only).
 * Every migration AFTER it is a REAL rollout against a database with a live
 * predecessor, and for those,
 * `src/db/__tests__/gates.test.ts`'s "deploy-phase ordering (post-genesis)"
 * describe block enforces the invariant this window itself does not satisfy:
 * no `pre` migration may be ordered behind a `post` one. That is what makes
 * `--phase=pre`/`--phase=post` trustworthy now that real rollouts need them.
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
import { describeErrorSafely } from '../utils/error';

/** How far above this module `drizzle/` may sit before the search gives up. */
const MIGRATIONS_SEARCH_DEPTH = 6;

/**
 * The journal tag of the last GENESIS migration — see this file's own doc
 * comment, "THE GENESIS BOOTSTRAP WINDOW", for what that means and how the line
 * moved before it froze. Every migration up to and including this one is exempt
 * from the pre-behind-post ordering invariant; every migration after it is held
 * to it by `gates.test.ts`'s "deploy-phase ordering (post-genesis)" describe
 * block.
 *
 * Exported so that gate can read the SAME boundary this file documents,
 * rather than a second copy of the tag string that could drift from it.
 *
 * **FROZEN. DO NOT ADVANCE IT — cutover happened on 2026-08-08.** This is the
 * one edit to this file that is never correct again, and the one whose damage is
 * invisible: `findPostGenesisPhaseOrderingViolations` inspects only
 * `entries.slice(boundaryIndex + 1)`, so moving the boundary to the newest
 * migration leaves it a permanently EMPTY tail. The `pre`-behind-`post`
 * invariant then checks nothing, forever, with every test green — advancing this
 * does not relax the rule, it deletes it. The test that used to require this to
 * be the newest tag was deleted at cutover, exactly as it and this comment
 * instructed; `gates.test.ts`'s "is frozen at the cutover boundary" pins the
 * value in its place, and is the thing that will fail if somebody bumps this out
 * of habit.
 *
 * A migration landing today is `0025` or later, sits AFTER this boundary, and is
 * checked. That is the whole point of leaving the constant where it is.
 */
export const LAST_GENESIS_MIGRATION_TAG = '0024_ambitious_xorn';

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
    logger.error('Postgres migration failed', { error: describeErrorSafely(error) });
    // Not `process.exit`: the pino transport used in development writes from
    // a worker thread, and exiting here would truncate the very message that
    // says what went wrong. The event loop is already free once the pool is
    // closed.
    process.exitCode = 1;
  });
}
