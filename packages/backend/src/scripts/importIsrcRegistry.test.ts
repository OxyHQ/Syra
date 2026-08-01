import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clear, connect, disconnect } from '../test/mongo';
import { IsrcRegistryModel } from '../models/IsrcRegistry';
import { importIsrcRegistry } from './importIsrcRegistry';

beforeAll(connect);
beforeEach(async () => {
  await IsrcRegistryModel.createIndexes();
});
afterEach(clear);
afterAll(disconnect);

const DUMP_TIMESTAMP = '2026-08-01 00:22:50';

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

describe('importIsrcRegistry', () => {
  it('imports the join, keyed by ISRC', async () => {
    const dump = makeDump();
    const summary = await importIsrcRegistry({
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
      skipReleaseCounts: false,
    });

    expect(summary.isrcRowsRead).toBe(3);
    expect(summary.documentsWritten).toBe(2);
    expect(summary.skippedUnresolved).toBe(1);

    const midnight = await IsrcRegistryModel.findOne({ isrc: 'ESA452300137' }).lean();
    expect(midnight?.recordingMbid).toBe('5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7');
    expect(midnight?.title).toBe('Midnight Ferry');
    expect(midnight?.artistCredit).toBe('Nadia Ortíz');
    // Normalised the same way an artist's own `nameKey` is, so resolution is one
    // indexed lookup rather than a normalise-everything scan.
    expect(midnight?.artistCreditNameKey).toBe('nadia ortiz');
    expect(midnight?.lengthMs).toBe(152000);
    expect(midnight?.releaseCount).toBe(1);

    const sodium = await IsrcRegistryModel.findOne({ isrc: 'GBAYE9800712' }).lean();
    // Two `track` rows reference this recording — it appears on two releases.
    expect(sodium?.releaseCount).toBe(2);
  });

  it('drops a row whose recording does not resolve rather than half-populating it', async () => {
    const dump = makeDump();
    await importIsrcRegistry({
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
      skipReleaseCounts: false,
    });

    // The whole value of this collection is that a hit means "a real catalogued
    // release"; a placeholder row would make the screening marker fire on nothing.
    expect(await IsrcRegistryModel.findOne({ isrc: 'USUM71900001' }).lean()).toBeNull();
  });

  it('is idempotent — a second run over the same dump changes nothing', async () => {
    const dump = makeDump();
    const options = {
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
      skipReleaseCounts: false,
    };

    await importIsrcRegistry(options);
    const first = await IsrcRegistryModel.find().sort({ isrc: 1 }).lean();

    // The checkpoint would otherwise resume past everything, so this run starts
    // clean the way a re-import of the same dump does after a completed pass.
    fs.rmSync(dump.checkpointPath);
    await importIsrcRegistry(options);
    const second = await IsrcRegistryModel.find().sort({ isrc: 1 }).lean();

    expect(second).toHaveLength(2);
    expect(second.map((row) => row.isrc)).toEqual(first.map((row) => row.isrc));
    expect(second.map((row) => row._id.toString())).toEqual(
      first.map((row) => row._id.toString()),
    );
  });

  it('updates in place when a newer dump changes a title', async () => {
    const dump = makeDump();
    const options = {
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
      skipReleaseCounts: false,
    };
    await importIsrcRegistry(options);
    const before = await IsrcRegistryModel.findOne({ isrc: 'ESA452300137' }).lean();

    fs.writeFileSync(
      path.join(dump.dumpDir, 'recording'),
      '101\t5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7\tMidnight Ferry (Remastered)\t9001\t152000\t\t0\t2023-05-01 00:00:00+00\tf\n',
    );
    fs.rmSync(dump.checkpointPath);
    await importIsrcRegistry(options);

    const after = await IsrcRegistryModel.findOne({ isrc: 'ESA452300137' }).lean();
    expect(after?.title).toBe('Midnight Ferry (Remastered)');
    // The SAME document, updated — not a second row for the same ISRC.
    expect(after?._id.toString()).toBe(before?._id.toString() ?? '');
    expect(await IsrcRegistryModel.countDocuments({ isrc: 'ESA452300137' })).toBe(1);
    // The row the second dump no longer mentions is left alone rather than
    // deleted: an import is an upsert, not a mirror, so a truncated dump cannot
    // empty the registry.
    expect(await IsrcRegistryModel.countDocuments()).toBe(2);
  });

  it('resumes from the checkpoint instead of re-reading committed rows', async () => {
    const dump = makeDump();
    fs.writeFileSync(
      dump.checkpointPath,
      JSON.stringify({ dumpTimestamp: DUMP_TIMESTAMP, committedRows: 2 }),
    );

    const summary = await importIsrcRegistry({
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
      skipReleaseCounts: false,
    });

    expect(summary.skippedResumed).toBe(2);
    expect(summary.documentsWritten).toBe(0);
    expect(await IsrcRegistryModel.countDocuments()).toBe(0);
  });

  it('writes the checkpoint as it goes, so an interrupted run can continue', async () => {
    const dump = makeDump();
    await importIsrcRegistry({
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 1,
      skipReleaseCounts: false,
    });

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
    await expect(
      importIsrcRegistry({
        dumpDir: dump.dumpDir,
        checkpointPath: dump.checkpointPath,
        batchSize: 100,
        skipReleaseCounts: false,
      }),
    ).rejects.toThrow(/2026-07-01/);
  });

  it('refuses a dump directory with no TIMESTAMP beside it', async () => {
    const dump = makeDump();
    fs.rmSync(path.join(dump.root, 'TIMESTAMP'));

    await expect(
      importIsrcRegistry({
        dumpDir: dump.dumpDir,
        checkpointPath: dump.checkpointPath,
        batchSize: 100,
        skipReleaseCounts: false,
      }),
    ).rejects.toThrow(/TIMESTAMP/);
  });

  it('names the missing table when one is absent', async () => {
    const dump = makeDump();
    fs.rmSync(path.join(dump.dumpDir, 'artist_credit'));

    await expect(
      importIsrcRegistry({
        dumpDir: dump.dumpDir,
        checkpointPath: dump.checkpointPath,
        batchSize: 100,
        skipReleaseCounts: false,
      }),
    ).rejects.toThrow(/artist_credit/);
  });

  it('undoes PostgreSQL COPY escaping in values', async () => {
    const dump = makeDump({
      recording: [
        // A tab, a newline and a literal backslash inside the title, plus a NULL
        // length — all four of the escapes the COPY text format uses.
        '101\t5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7\tA\\tB\\nC\\\\D\t9001\t\\N\t\t0\t2023-05-01 00:00:00+00\tf',
      ],
    });

    await importIsrcRegistry({
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
      skipReleaseCounts: false,
    });

    const row = await IsrcRegistryModel.findOne({ isrc: 'ESA452300137' }).lean();
    expect(row?.title).toBe('A\tB\nC\\D');
    expect(row?.lengthMs).toBeUndefined();
  });

  it('uppercases the ISRC key', async () => {
    const dump = makeDump({
      isrc: ['1\t101\tesa452300137\t0\t2023-05-01 00:00:00+00'],
    });
    await importIsrcRegistry({
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
      skipReleaseCounts: false,
    });

    expect(await IsrcRegistryModel.findOne({ isrc: 'ESA452300137' }).lean()).not.toBeNull();
  });

  it('--skip-release-counts imports every row with releaseCount 0', async () => {
    const dump = makeDump();
    await importIsrcRegistry({
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
      skipReleaseCounts: true,
    });

    const rows = await IsrcRegistryModel.find().lean();
    expect(rows).toHaveLength(2);
    // Documented consequence: with no counts, the screening marker downgrades
    // from blocking to high, because "resolves to a RELEASE" cannot be asserted.
    for (const row of rows) expect(row.releaseCount).toBe(0);
  });
});
