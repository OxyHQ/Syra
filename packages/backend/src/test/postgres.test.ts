import { describe, it, expect } from 'bun:test';
import { assertDisposableDatabase, clearDb, connectDb } from './postgres';

/**
 * The guard that stops `clearDb` TRUNCATEing a database someone else is using.
 *
 * This suite deliberately does NOT call `connectDb` — it is about the decision,
 * not the connection, and a test for a guard that protects a shared database
 * must not itself need one.
 *
 * The fixtures that matter are the ones where a naive implementation and this
 * one DISAGREE, since every obvious name (`syra_test` accepted, `syra_dev`
 * refused) is answered the same way by both:
 *
 *  - `syra_special` — contains "ci" as a SUBSTRING (spe-ci-al). A regex over the
 *    whole name would allow it. This is the fixture that makes segment matching
 *    load-bearing rather than a stylistic choice, and it fails OPEN, which is
 *    the dangerous direction.
 *  - `syra_taskless` — starts with "task" but is not a task database. Without
 *    the digit in the pattern this is allowed.
 *  - a URL with no database at all — has no name to judge, so it must be refused
 *    rather than passing a check that had nothing to check.
 */

const AT = 'postgres://u:p@127.0.0.1:5545';

describe('assertDisposableDatabase', () => {
  it('accepts a database that names itself disposable', () => {
    for (const name of ['syra_test', 'syra_tests', 'syra_ci', 'syra_task16', 'syra_task13a', 'test']) {
      expect(() => assertDisposableDatabase(`${AT}/${name}`)).not.toThrow();
    }
  });

  it('refuses the shared dev database the local .env defaults to', () => {
    expect(() => assertDisposableDatabase(`${AT}/syra_dev`)).toThrow(/syra_dev/);
  });

  /**
   * Fails closed. None of these is a name the rule has been taught, and each
   * must be refused BECAUSE of that rather than allowed pending a listing.
   */
  it('refuses any database it has not been shown', () => {
    for (const name of ['syra', 'syra_prod', 'syra_production', 'postgres', 'syra_staging']) {
      expect(() => assertDisposableDatabase(`${AT}/${name}`)).toThrow(new RegExp(name));
    }
  });

  it('refuses a name that merely contains a marker as a substring', () => {
    // 'ci' inside 'special', 'precision', 'municipal' — the fail-open case.
    for (const name of ['syra_special', 'syra_precision', 'syra_municipal', 'syra_testing']) {
      expect(() => assertDisposableDatabase(`${AT}/${name}`)).toThrow(new RegExp(name));
    }
  });

  it('refuses `task` without a counter', () => {
    expect(() => assertDisposableDatabase(`${AT}/syra_taskless`)).toThrow(/syra_taskless/);
    expect(() => assertDisposableDatabase(`${AT}/syra_task`)).toThrow(/syra_task/);
  });

  it('refuses a URL that names no database, and one that is not a URL', () => {
    expect(() => assertDisposableDatabase(AT)).toThrow(/names no database/);
    expect(() => assertDisposableDatabase(`${AT}/`)).toThrow(/names no database/);
    expect(() => assertDisposableDatabase('not a url')).toThrow(/names no database/);
  });

  /**
   * The message is the entire user interface of this guard — whoever trips it is
   * mid-run and needs to know which database was refused and what to do, without
   * reading this file.
   */
  it('names the database it refused and what to set', () => {
    let message = '';
    try {
      assertDisposableDatabase(`${AT}/syra_dev`);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('syra_dev');
    expect(message).toContain('TEST_DATABASE_URL');
    expect(message).toContain('db:migrate');
    expect(message).toContain('syra_task16');
  });
});

/**
 * The WIRING, which the block above does not test.
 *
 * A correct predicate that nothing calls protects nothing — the same shape as a
 * spy that was never attached to the code under test. These two assert that the
 * refusal actually reaches `connectDb` and `clearDb`, so deleting either call
 * site fails a test rather than silently removing the guard.
 *
 * Safe to run because the assertion throws BEFORE either function touches the
 * database: no connection is opened and no statement is issued against the name
 * under test. `TEST_DATABASE_URL` is restored in `finally` — bun runs test files
 * serially in one process (see `postgres.ts`), so no concurrent suite can
 * observe the swap, and it is a scalar this file owns rather than a shared
 * module's behaviour.
 */
async function withDatabaseUrl(url: string, run: () => Promise<unknown>): Promise<unknown> {
  const previous = process.env.TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = url;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = previous;
  }
}

describe('the guard is wired into the destructive path', () => {
  it('clearDb refuses rather than truncating', async () => {
    await expect(
      withDatabaseUrl(`${AT}/syra_dev`, () => clearDb())
    ).rejects.toThrow(/Refusing to run the suite against the database "syra_dev"/);
  });

  it('connectDb refuses before opening the pool', async () => {
    await expect(
      withDatabaseUrl(`${AT}/syra_dev`, () => connectDb())
    ).rejects.toThrow(/Refusing to run the suite against the database "syra_dev"/);
  });
});
