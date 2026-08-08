/**
 * The ISRC importer, and the reader it exists to feed.
 *
 * Two things here are load-bearing beyond "the rows land":
 *
 *  - `starvation is closed` drives `resolveIsrc` — the real reader — across the
 *    import. Asserting only that rows appeared would not show that the reader
 *    stopped returning a confident negative, which is the entire point of this
 *    script and the failure mode nobody would ever see in production.
 *  - `two recordings sharing one ISRC` is the fixture that tells a correct
 *    implementation from a naive one. MusicBrainz maps recordings to ISRCs
 *    many-to-many, so the same code reaches one batch twice; Mongo's `bulkWrite`
 *    applied both and the last won, while Postgres rejects two rows with the same
 *    conflict key in one statement with `21000`. Every other fixture in this file
 *    has distinct ISRCs and cannot tell the two apart.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { asc, eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { isrcRegistry } from '../db/schema/catalog';
import {
  resetIsrcLookupForTests,
  resolveIsrc,
  setDeezerFetchForTests,
} from '../services/uploads/isrcLookup';
import { importIsrcRegistry } from './importIsrcRegistry';

const deezerPayloads = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', 'services', 'uploads', '__fixtures__', 'deezer-payloads.json'),
    'utf8',
  ),
) as { unknownIsrc: unknown };

beforeAll(connectDb);
afterEach(async () => {
  await clearDb();
  resetIsrcLookupForTests();
  setDeezerFetchForTests();
});
afterAll(disconnectDb);

const DUMP_TIMESTAMP = '2026-08-01 00:22:50';

function readRow(isrc: string) {
  return getDb()
    .select()
    .from(isrcRegistry)
    .where(eq(isrcRegistry.isrc, isrc))
    .limit(1)
    .then((rows) => rows[0]);
}

function readAll() {
  return getDb().select().from(isrcRegistry).orderBy(asc(isrcRegistry.isrc));
}

/**
 * Build a miniature MusicBrainz export.
 *
 * Column ORDER is the thing under test as much as the parsing is — it comes from
 * `admin/sql/CreateTables.sql` and a mis-numbered column would silently import
 * the wrong field into every row. These rows carry the real layouts, verified
 * against the 2026-08-01 export:
 *
 *   isrc          id, recording, isrc, edits_pending, created
 *   recording     id, gid, name, artist_credit, length, comment, edits_pending, last_updated, video
 *   artist_credit id, name, artist_count, ref_count, created, edits_pending, gid
 *   track         id, gid, recording, medium, position, number, name, artist_credit, length, …
 */
function writeDump(tables: Partial<Record<string, string[]>>): {
  root: string;
  dumpDir: string;
  checkpointPath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syra-isrc-dump-'));
  const dumpDir = path.join(root, 'mbdump');
  fs.mkdirSync(dumpDir);
  fs.writeFileSync(path.join(root, 'TIMESTAMP'), `${DUMP_TIMESTAMP}\n`);

  const defaults: Record<string, string[]> = {
    isrc: [
      '1\t101\tESA452300137\t0\t2023-05-01 00:00:00+00',
      '2\t102\tGBAYE9800712\t0\t1998-10-01 00:00:00+00',
      '3\t103\tUSUM71900001\t0\t2019-01-01 00:00:00+00',
    ],
    recording: [
      '101\t5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7\tMidnight Ferry\t9001\t152000\t\t0\t2023-05-01 00:00:00+00\tf',
      '102\tc1e3f4a0-9f19-4b1e-9b52-6c8f8a0d4f11\tSodium Light\t9002\t287000\t\t0\t1998-10-01 00:00:00+00\tf',
      // 103 is deliberately absent: an ISRC whose recording does not resolve.
    ],
    artist_credit: [
      '9001\tNadia Ortíz\t1\t5\t2023-01-01 00:00:00+00\t0\t11111111-1111-4111-8111-111111111111',
      '9002\tKestrel Lane\t1\t9\t1998-01-01 00:00:00+00\t0\t22222222-2222-4222-8222-222222222222',
    ],
    track: [
      '1\taaaaaaaa-0000-4000-8000-000000000001\t101\t500\t3\t3\tMidnight Ferry\t9001\t152000\t0\t2023-05-01 00:00:00+00\tf',
      '2\taaaaaaaa-0000-4000-8000-000000000002\t102\t501\t7\t7\tSodium Light\t9002\t287000\t0\t1998-10-01 00:00:00+00\tf',
      '3\taaaaaaaa-0000-4000-8000-000000000003\t102\t502\t4\t4\tSodium Light\t9002\t287000\t0\t2005-10-01 00:00:00+00\tf',
    ],
  };

  for (const [table, rows] of Object.entries({ ...defaults, ...tables })) {
    fs.writeFileSync(path.join(dumpDir, table), `${(rows ?? []).join('\n')}\n`);
  }

  return { root, dumpDir, checkpointPath: path.join(root, 'checkpoint.json') };
}

const created: string[] = [];
function makeDump(tables: Partial<Record<string, string[]>> = {}) {
  const dump = writeDump(tables);
  created.push(dump.root);
  return dump;
}

afterAll(() => {
  for (const root of created) fs.rmSync(root, { recursive: true, force: true });
});

function importOptions(dump: { dumpDir: string; checkpointPath: string }, overrides = {}) {
  return {
    dumpDir: dump.dumpDir,
    checkpointPath: dump.checkpointPath,
    batchSize: 100,
    skipReleaseCounts: false,
    ...overrides,
  };
}

describe('importIsrcRegistry', () => {
  it('imports the join, keyed by ISRC', async () => {
    const dump = makeDump();
    const summary = await importIsrcRegistry(importOptions(dump));

    expect(summary.isrcRowsRead).toBe(3);
    expect(summary.rowsWritten).toBe(2);
    expect(summary.skippedUnresolved).toBe(1);

    const midnight = await readRow('ESA452300137');
    expect(midnight?.recordingMbid).toBe('5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7');
    expect(midnight?.title).toBe('Midnight Ferry');
    expect(midnight?.artistCredit).toBe('Nadia Ortíz');
    // Normalised the same way an artist's own `nameKey` is, so resolution is one
    // indexed lookup rather than a normalise-everything scan.
    expect(midnight?.artistCreditNameKey).toBe('nadia ortiz');
    expect(midnight?.lengthMs).toBe(152000);
    expect(midnight?.releaseCount).toBe(1);

    const sodium = await readRow('GBAYE9800712');
    // Two `track` rows reference this recording — it appears on two releases.
    expect(sodium?.releaseCount).toBe(2);
  });

  it('drops a row whose recording does not resolve rather than half-populating it', async () => {
    const dump = makeDump();
    await importIsrcRegistry(importOptions(dump));

    // The whole value of this table is that a hit means "a real catalogued
    // release"; a placeholder row would make the screening marker fire on nothing.
    expect(await readRow('USUM71900001')).toBeUndefined();
  });

  /**
   * The case that distinguishes the `Map` from an array of upserts.
   *
   * `1` and `4` are two `isrc` rows carrying the SAME code for two different
   * recordings, which is ordinary MusicBrainz data rather than corruption. An
   * implementation that pushed both into one `INSERT … ON CONFLICT DO UPDATE`
   * fails the statement with `21000 — ON CONFLICT DO UPDATE command cannot
   * affect row a second time`, taking the whole batch down with it.
   *
   * Verified by mutation: replacing the batch `Map` with an array of the same
   * rows fails this test with exactly that SQLSTATE, and leaves every other test
   * in this file green.
   */
  it('survives two recordings sharing one ISRC, last one winning as Mongo did', async () => {
    const dump = makeDump({
      isrc: [
        '1\t101\tESA452300137\t0\t2023-05-01 00:00:00+00',
        '4\t102\tESA452300137\t0\t2024-05-01 00:00:00+00',
      ],
    });

    const summary = await importIsrcRegistry(importOptions(dump));

    expect(summary.isrcRowsRead).toBe(2);
    // Two dump rows, ONE registry row — the second collapsed onto the first.
    expect(summary.rowsWritten).toBe(1);

    const rows = await readAll();
    expect(rows).toHaveLength(1);
    // Last write wins, matching what `bulkWrite` did with two sequential upserts.
    expect(rows[0]?.title).toBe('Sodium Light');
  });

  it('is idempotent — a second run over the same dump changes nothing', async () => {
    const dump = makeDump();
    const options = importOptions(dump);

    await importIsrcRegistry(options);
    const first = await readAll();

    /**
     * Deleting the checkpoint is what makes this test about the UPSERT.
     *
     * Left in place it sits at the total and the second run skips every row
     * before reaching a write, so the table would be unchanged no matter what
     * the conflict clause did — green, and measuring nothing. The two mechanisms
     * are separable and only one of them is under test here.
     */
    fs.rmSync(dump.checkpointPath);
    await importIsrcRegistry(options);
    const second = await readAll();

    expect(second).toHaveLength(2);
    expect(second.map((row) => row.isrc)).toEqual(first.map((row) => row.isrc));
    // The same ROWS, updated in place — not a second generation of ids.
    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
  });

  it('updates in place when a newer dump changes a title', async () => {
    const dump = makeDump();
    const options = importOptions(dump);
    await importIsrcRegistry(options);
    const before = await readRow('ESA452300137');

    fs.writeFileSync(
      path.join(dump.dumpDir, 'recording'),
      '101\t5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7\tMidnight Ferry (Remastered)\t9001\t152000\t\t0\t2023-05-01 00:00:00+00\tf\n',
    );
    fs.rmSync(dump.checkpointPath);
    await importIsrcRegistry(options);

    const after = await readRow('ESA452300137');
    expect(after?.title).toBe('Midnight Ferry (Remastered)');
    // The SAME row, updated — not a second one for the same ISRC.
    expect(after?.id).toBe(before?.id ?? '');
    // The row the second dump no longer mentions is left alone rather than
    // deleted: an import is an upsert, not a mirror, so a truncated dump cannot
    // empty the registry.
    expect(await readAll()).toHaveLength(2);
  });

  /**
   * The one place the Postgres port deliberately behaves differently from Mongo.
   *
   * The conflict `SET` writes `excluded.length_ms`, and a row whose recording has
   * no length omits the column — so drizzle emits `default`, `excluded.length_ms`
   * is NULL, and the previously-stored length is CLEARED. Mongo's `$set` omitted
   * the key entirely and the stale value survived every future import.
   *
   * This table mirrors somebody else's dataset. When MusicBrainz stops asserting
   * a length, the mirror has to stop asserting it too.
   */
  it('CLEARS a length the newer dump no longer states, rather than keeping a stale one', async () => {
    const dump = makeDump();
    const options = importOptions(dump);
    await importIsrcRegistry(options);
    expect((await readRow('ESA452300137'))?.lengthMs).toBe(152000);

    fs.writeFileSync(
      path.join(dump.dumpDir, 'recording'),
      '101\t5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7\tMidnight Ferry\t9001\t\\N\t\t0\t2023-05-01 00:00:00+00\tf\n',
    );
    fs.rmSync(dump.checkpointPath);
    await importIsrcRegistry(options);

    expect((await readRow('ESA452300137'))?.lengthMs).toBeNull();
  });

  it('resumes from the checkpoint instead of re-reading committed rows', async () => {
    const dump = makeDump();
    fs.writeFileSync(
      dump.checkpointPath,
      JSON.stringify({ dumpTimestamp: DUMP_TIMESTAMP, committedRows: 2 }),
    );

    const summary = await importIsrcRegistry(importOptions(dump));

    expect(summary.skippedResumed).toBe(2);
    expect(summary.rowsWritten).toBe(0);
    expect(await readAll()).toHaveLength(0);
  });

  it('writes the checkpoint as it goes, so an interrupted run can continue', async () => {
    const dump = makeDump();
    await importIsrcRegistry(importOptions(dump, { batchSize: 1 }));

    const checkpoint = JSON.parse(fs.readFileSync(dump.checkpointPath, 'utf8')) as {
      dumpTimestamp: string;
      committedRows: number;
    };
    expect(checkpoint.dumpTimestamp).toBe(DUMP_TIMESTAMP);
    expect(checkpoint.committedRows).toBe(3);
  });

  it('REFUSES to resume a checkpoint from a different dump', async () => {
    const dump = makeDump();
    fs.writeFileSync(
      dump.checkpointPath,
      JSON.stringify({ dumpTimestamp: '2026-07-01 00:00:00', committedRows: 2 }),
    );

    // Row offsets are not comparable across dumps: resuming would skip rows that
    // are not the rows already imported, and the gap would be invisible.
    await expect(importIsrcRegistry(importOptions(dump))).rejects.toThrow(/2026-07-01/);
  });

  it('refuses a dump directory with no TIMESTAMP beside it', async () => {
    const dump = makeDump();
    fs.rmSync(path.join(dump.root, 'TIMESTAMP'));

    await expect(importIsrcRegistry(importOptions(dump))).rejects.toThrow(/TIMESTAMP/);
  });

  it('names the missing table when one is absent', async () => {
    const dump = makeDump();
    fs.rmSync(path.join(dump.dumpDir, 'artist_credit'));

    await expect(importIsrcRegistry(importOptions(dump))).rejects.toThrow(/artist_credit/);
  });

  it('undoes PostgreSQL COPY escaping in values', async () => {
    const dump = makeDump({
      recording: [
        // A tab, a newline and a literal backslash inside the title, plus a NULL
        // length — all four of the escapes the COPY text format uses.
        '101\t5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7\tA\\tB\\nC\\\\D\t9001\t\\N\t\t0\t2023-05-01 00:00:00+00\tf',
      ],
    });

    await importIsrcRegistry(importOptions(dump));

    const row = await readRow('ESA452300137');
    expect(row?.title).toBe('A\tB\nC\\D');
    // `lengthMs` is a nullable COLUMN now, where Mongo simply had no key.
    expect(row?.lengthMs).toBeNull();
  });

  it('uppercases the ISRC key', async () => {
    const dump = makeDump({
      isrc: ['1\t101\tesa452300137\t0\t2023-05-01 00:00:00+00'],
    });
    await importIsrcRegistry(importOptions(dump));

    expect(await readRow('ESA452300137')).toBeDefined();
  });

  it('--skip-release-counts imports every row with releaseCount 0', async () => {
    const dump = makeDump();
    await importIsrcRegistry(importOptions(dump, { skipReleaseCounts: true }));

    const rows = await readAll();
    expect(rows).toHaveLength(2);
    // Documented consequence: with no counts, the screening marker downgrades
    // from blocking to high, because "resolves to a RELEASE" cannot be asserted.
    for (const row of rows) expect(row.releaseCount).toBe(0);
  });
});

/**
 * The reason this script was pulled out of Task 19.
 *
 * `isrcLookup` reads `isrc_registry` and this importer is the only thing that
 * fills it, so before the import the reader answers "I have never heard of this
 * code" — which is exactly what it answers for a genuinely unknown one. The
 * negative control below is therefore not decoration: without it, a test that
 * only checked the post-import result could not tell a working reader from one
 * that always says `found`.
 */
describe('importIsrcRegistry — the starvation it closes', () => {
  /**
   * Deezer is the fallback path, pinned to "this code is unknown" so only the
   * registry can supply an answer.
   *
   * The payload is the REAL captured one `isrcLookup.test.ts` uses — a `200 OK`
   * carrying an error object, which is the shape a parser trusting the HTTP
   * status would read as a successful resolution. Returning `undefined` instead
   * would mean "the request failed", and `resolveIsrc` reports that as
   * `unavailable` rather than `not-found`, so the negative control below would
   * have been asserting the wrong thing.
   */
  const noDeezer = () => setDeezerFetchForTests(async () => deezerPayloads.unknownIsrc);

  it('resolveIsrc finds nothing before the import and the recording after it', async () => {
    noDeezer();

    const before = await resolveIsrc('ESA452300137');
    expect(before.status).toBe('not-found');

    // The reader caches its answers, so a stale negative would make the second
    // half of this test pass for the wrong reason.
    resetIsrcLookupForTests();
    noDeezer();

    const dump = makeDump();
    await importIsrcRegistry(importOptions(dump));

    const after = await resolveIsrc('ESA452300137');
    expect(after.status).toBe('found');
    if (after.status !== 'found') throw new Error('unreachable — asserted above');
    expect(after.recording.source).toBe('isrc-registry');
    expect(after.recording.title).toBe('Midnight Ferry');
    expect(after.recording.artistName).toBe('Nadia Ortíz');
    // Milliseconds in the dump, seconds in the pipeline.
    expect(after.recording.durationSec).toBe(152);
  });

  it('still answers not-found for a code the dump never mentioned', async () => {
    noDeezer();
    const dump = makeDump();
    await importIsrcRegistry(importOptions(dump));
    resetIsrcLookupForTests();
    noDeezer();

    // `USUM71900001` IS in the dump but its recording does not resolve, so it was
    // dropped. A loaded table must not turn that into a false positive.
    expect((await resolveIsrc('USUM71900001')).status).toBe('not-found');
  });
});
