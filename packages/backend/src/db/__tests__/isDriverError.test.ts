/**
 * `isDriverError` — the classifier that decides whether a log gets redacted.
 *
 * This is the half worth testing. `describeDriverError` (from `@oxyhq/db`) only
 * formats; the branch that chooses when to call it is what decides which
 * subsystem an operator is sent to at 3am, and it is the part every vertical
 * adopting the redaction convention has to get right.
 *
 * The fixtures are deliberately hostile, because the obvious predicates all pass
 * a tidy fixture set:
 *
 *  - `sqlStateOf(err) !== undefined` — matches ENOENT, ENOSPC, NoSuchKey, EPIPE.
 *    This was the shipped bug.
 *  - "the code looks like a SQLSTATE" (five of `[0-9A-Z]`) — matches `EPIPE`,
 *    which is a plausible failure of the very `pipeline()` the backfill runs.
 *
 * So every case below is one where a wrong predicate and the right one disagree.
 * A fixture set of only `new Error()` and a real driver error cannot tell any of
 * these predicates apart.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { sqlStateOf } from '@oxyhq/db';
import { isDriverError } from '../postgres';

/** The shape drizzle produces: its own wrapper carrying the statement, with the driver beneath. */
function drizzleWrapped(code: string, extra: Record<string, unknown> = {}): Error {
  const driver = Object.assign(new Error('duplicate key value violates unique constraint'), {
    name: 'PostgresError',
    code,
    ...extra,
  });
  return Object.assign(new Error('Failed query: insert into "t" …'), {
    query: 'insert into "t" ("a") values ($1)',
    params: ['a-secret-value'],
    cause: driver,
  });
}

describe('isDriverError — errors that are NOT the database', () => {
  /**
   * The archetype, and not hypothetical: `/tmp` filling on this machine is a
   * documented recurring condition, and a catalogue-wide backfill stages every
   * track through it.
   */
  it('a real ENOENT from the staging pipeline is not a driver error', async () => {
    let caught: unknown;
    try {
      await pipeline(
        Readable.from([Buffer.from('x')]),
        fs.createWriteStream('/nonexistent-dir-19a-test/staged.mp3'),
      );
    } catch (err) {
      caught = err;
    }

    // The predicate that shipped: this is exactly why it was wrong.
    expect(sqlStateOf(caught)).toBe('ENOENT');
    expect(isDriverError(caught)).toBe(false);
    // And the message — the only useful thing here — survives to be logged.
    expect(String((caught as Error).message)).toContain('ENOENT');
  });

  it('a full disk is not a driver error', () => {
    const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });

    expect(sqlStateOf(enospc)).toBe('ENOSPC');
    expect(isDriverError(enospc)).toBe(false);
  });

  it('an S3 SDK error is not a driver error', () => {
    const s3 = Object.assign(new Error('The specified key does not exist.'), {
      name: 'NoSuchKey',
      code: 'NoSuchKey',
    });

    expect(isDriverError(s3)).toBe(false);
  });

  /**
   * `EPIPE` is five characters of `[0-9A-Z]` — the exact shape of a SQLSTATE.
   * It is why the classifier cannot test the code's FORM either, and it comes
   * from writing to a closed stream, which is what the staging step does.
   */
  it('EPIPE is SQLSTATE-SHAPED and still not a driver error', () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    expect(epipe.code).toMatch(/^[0-9A-Z]{5}$/);
    expect(isDriverError(epipe)).toBe(false);
  });

  it('a pool that was never opened is not a driver error', () => {
    // `getDb() called before connectPostgres()` — a condition this project's
    // shared verify container produces when it crash-recovers mid-run. Its
    // message is the whole diagnosis and must not be discarded.
    expect(isDriverError(new Error('getDb() called before connectPostgres()'))).toBe(false);
  });

  it('a plain error is not a driver error', () => {
    expect(isDriverError(new Error('something broke'))).toBe(false);
    expect(isDriverError('a string')).toBe(false);
    expect(isDriverError(undefined)).toBe(false);
  });
});

describe('isDriverError — errors that ARE the database', () => {
  it('recognises a drizzle-wrapped driver error by its statement payload', () => {
    expect(isDriverError(drizzleWrapped('23505'))).toBe(true);
  });

  it('recognises one whose SQLSTATE lives on the cause, not the wrapper', () => {
    // The trap `@oxyhq/db`'s own header names: drizzle wraps the driver failure,
    // so `code` is on `cause`. The walk has to descend.
    const wrapped = drizzleWrapped('23503');
    expect(Reflect.get(wrapped, 'code')).toBeUndefined();
    expect(isDriverError(wrapped)).toBe(true);
  });

  /**
   * A raw postgres.js error that never passed through drizzle carries no
   * `query`/`params`, but Postgres's `detail` reads `Failing row contains (…)`
   * — the same leak by another name, which is why `detail` is in the walk.
   */
  it('recognises a bare driver error carrying only `detail`', () => {
    const bare = Object.assign(new Error('duplicate key'), {
      name: 'PostgresError',
      code: '23505',
      detail: 'Failing row contains (1, a-secret-value).',
    });

    expect(isDriverError(bare)).toBe(true);
  });
});
