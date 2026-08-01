import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clear, connect, disconnect } from '../test/mongo';
import { MusicBrainzArtistModel } from '../models/MusicBrainzArtist';
import { importMusicBrainzArtists } from './importMusicBrainzArtists';

beforeAll(connect);
beforeEach(async () => {
  await MusicBrainzArtistModel.createIndexes();
});
afterEach(clear);
afterAll(disconnect);

const DUMP_TIMESTAMP = '2026-08-01 00:22:50';
const BEATLES_MBID = 'b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d';

/**
 * A miniature `mbdump/`, in the real column layouts.
 *
 * Column ORDER is as much under test as the parsing: it comes from
 * `admin/sql/CreateTables.sql` and a mis-numbered column imports the wrong field
 * into every row without failing anything. These layouts were read from the
 * authoritative schema and the TSV escaping (`\N`, tabs) confirmed against a
 * real 80 MB slice of `mbdump.tar.bz2`.
 *
 *   artist        id, gid, name, sort_name, begin_y, begin_m, begin_d, end_y, end_m, end_d,
 *                 type, area, gender, comment, edits_pending, last_updated, ended, …
 *   artist_type   id, name, parent, child_order, description, gid
 *   area          id, gid, name, type, …
 *   iso_3166_1    area, code
 *   artist_alias  id, artist, name, locale, …
 *   artist_isni   artist, isni, edits_pending, created
 *   artist_ipi    artist, ipi, edits_pending, created
 *   url           id, gid, url, edits_pending, last_updated
 *   l_artist_url  id, link, entity0 (artist), entity1 (url), …
 *   link          id, link_type, …
 *   link_type     id, parent, child_order, gid, entity_type0, entity_type1, name, …
 */
function writeDump(overrides: Partial<Record<string, string[]>> = {}): {
  root: string;
  dumpDir: string;
  checkpointPath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'syra-mb-artist-'));
  const dumpDir = path.join(root, 'mbdump');
  fs.mkdirSync(dumpDir);
  fs.writeFileSync(path.join(root, 'TIMESTAMP'), `${DUMP_TIMESTAMP}\n`);

  const tables: Record<string, string[]> = {
    artist: [
      // The Beatles: a GROUP, formed 1960 (year precision only), ended 1970-04-10.
      `1\t${BEATLES_MBID}\tThe Beatles\tBeatles, The\t1960\t\\N\t\\N\t1970\t04\t10\t2\t221\t\\N\tBritish rock band\t0\t2026-01-01\tt\t\\N\t\\N`,
      // A solo artist with no dates and no comment at all.
      '2\tc8b03190-306c-4120-bb0b-6f2ebfc06ea9\tThe Rolling Stones\tRolling Stones, The\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N\t2\t221\t\\N\t\\N\t0\t2026-01-01\tf\t\\N\t\\N',
    ],
    artist_type: ['1\tPerson\t\\N\t1\t\\N\tgid-person', '2\tGroup\t\\N\t2\t\\N\tgid-group'],
    area: ['221\tgid-uk\tUnited Kingdom\t1\t0\t2026-01-01'],
    iso_3166_1: ['221\tGB'],
    artist_alias: [
      '10\t1\tThe Fab Four\ten\t0\t2026-01-01\t\\N\tFab Four, The',
      '11\t1\tBeatles\ten\t0\t2026-01-01\t\\N\tBeatles',
      '12\t1\tThe Fab Four\tde\t0\t2026-01-01\t\\N\tFab Four, The',
    ],
    artist_isni: ['1\t0000000121174585\t0\t2026-01-01'],
    artist_ipi: ['1\t00016000958\t0\t2026-01-01'],
    url: [
      '500\tgid-url-1\thttps://thebeatles.com\t0\t2026-01-01',
      '501\tgid-url-2\thttps://www.discogs.com/artist/82730\t0\t2026-01-01',
    ],
    link: ['900\t179\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N\t0\t2026-01-01\tf', '901\t180\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N\t0\t2026-01-01\tf'],
    link_type: [
      '179\t\\N\t0\tgid-lt-1\tartist\turl\tofficial homepage\tThe official website\t2026-01-01\t\\N',
      '180\t\\N\t0\tgid-lt-2\tartist\turl\tdiscogs\tThe Discogs page\t2026-01-01\t\\N',
    ],
    l_artist_url: [
      '1\t900\t1\t500\t0\t2026-01-01\t0\t\\N\t\\N',
      '2\t901\t1\t501\t0\t2026-01-01\t0\t\\N\t\\N',
    ],
  };

  for (const [table, rows] of Object.entries({ ...tables, ...overrides })) {
    fs.writeFileSync(path.join(dumpDir, table), `${(rows ?? []).join('\n')}\n`);
  }
  return { root, dumpDir, checkpointPath: path.join(root, 'checkpoint.json') };
}

const created: string[] = [];
function makeDump(overrides: Partial<Record<string, string[]>> = {}) {
  const dump = writeDump(overrides);
  created.push(dump.root);
  return dump;
}
afterAll(() => {
  for (const root of created) fs.rmSync(root, { recursive: true, force: true });
});

describe('importMusicBrainzArtists', () => {
  it('imports the artist identity keyed by MBID', async () => {
    const dump = makeDump();
    const summary = await importMusicBrainzArtists({
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
    });

    expect(summary.artistRowsRead).toBe(2);
    expect(summary.documentsWritten).toBe(2);

    const beatles = await MusicBrainzArtistModel.findOne({ mbid: BEATLES_MBID }).lean();
    expect(beatles?.name).toBe('The Beatles');
    expect(beatles?.sortName).toBe('Beatles, The');
    expect(beatles?.nameKey).toBe('the beatles');
    expect(beatles?.disambiguation).toBe('British rock band');
    expect(beatles?.artistType).toBe('group');
    expect(beatles?.ended).toBe(true);
    expect(beatles?.isni).toBe('0000000121174585');
    expect(beatles?.ipi).toBe('00016000958');
  });

  /**
   * The precision rule, on the dump side.
   *
   * MusicBrainz stores year, month and day in SEPARATE columns and leaves the
   * ones it does not know NULL. A band known only to have formed in 1960 must
   * import as `1960`, not `1960-01-01` — the latter puts a founding day on the
   * profile that no source ever claimed.
   */
  it('keeps a partial date partial', async () => {
    const dump = makeDump();
    await importMusicBrainzArtists({
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
    });

    const beatles = await MusicBrainzArtistModel.findOne({ mbid: BEATLES_MBID }).lean();
    expect(beatles?.beginDate).toBe('1960');
    expect(beatles?.endDate).toBe('1970-04-10');
  });

  it('resolves the area to a name and an ISO country code', async () => {
    const dump = makeDump();
    await importMusicBrainzArtists({
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
    });

    const beatles = await MusicBrainzArtistModel.findOne({ mbid: BEATLES_MBID }).lean();
    expect(beatles?.areaName).toBe('United Kingdom');
    expect(beatles?.countryCode).toBe('GB');
  });

  it('collects aliases without duplicating one written in two locales', async () => {
    const dump = makeDump();
    await importMusicBrainzArtists({
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
    });

    const beatles = await MusicBrainzArtistModel.findOne({ mbid: BEATLES_MBID }).lean();
    expect([...(beatles?.aliases ?? [])].sort()).toEqual(['Beatles', 'The Fab Four']);
  });

  /**
   * The four-table join. The relationship TYPE is what makes a URL useful —
   * "official homepage" belongs on a profile and a Discogs page does not, and
   * the URL alone cannot tell you which is which.
   */
  it('joins URL relationships through link → link_type to keep their meaning', async () => {
    const dump = makeDump();
    await importMusicBrainzArtists({
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
    });

    const beatles = await MusicBrainzArtistModel.findOne({ mbid: BEATLES_MBID }).lean();
    expect(beatles?.urls).toContainEqual({ type: 'official homepage', url: 'https://thebeatles.com' });
    expect(beatles?.urls).toContainEqual({
      type: 'discogs',
      url: 'https://www.discogs.com/artist/82730',
    });
  });

  it('leaves absent fields absent rather than writing empty strings', async () => {
    const dump = makeDump();
    await importMusicBrainzArtists({
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
    });

    const stones = await MusicBrainzArtistModel.findOne({
      mbid: 'c8b03190-306c-4120-bb0b-6f2ebfc06ea9',
    }).lean();
    expect(stones?.beginDate).toBeUndefined();
    expect(stones?.endDate).toBeUndefined();
    expect(stones?.disambiguation).toBeUndefined();
    expect(stones?.isni).toBeUndefined();
    expect(stones?.ended).toBe(false);
    expect(stones?.aliases).toEqual([]);
  });

  it('is idempotent and updates in place', async () => {
    const dump = makeDump();
    const options = {
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
    };
    await importMusicBrainzArtists(options);
    const first = await MusicBrainzArtistModel.findOne({ mbid: BEATLES_MBID }).lean();

    fs.rmSync(dump.checkpointPath);
    await importMusicBrainzArtists(options);
    const second = await MusicBrainzArtistModel.findOne({ mbid: BEATLES_MBID }).lean();

    expect(await MusicBrainzArtistModel.countDocuments()).toBe(2);
    expect(second?._id.toString()).toBe(first?._id.toString() ?? '');
  });

  it('resumes from the checkpoint and refuses one from another dump', async () => {
    const dump = makeDump();
    fs.writeFileSync(
      dump.checkpointPath,
      JSON.stringify({ dumpTimestamp: DUMP_TIMESTAMP, committedRows: 2 }),
    );
    const summary = await importMusicBrainzArtists({
      dumpDir: dump.dumpDir,
      checkpointPath: dump.checkpointPath,
      batchSize: 100,
    });
    expect(summary.skippedResumed).toBe(2);
    expect(summary.documentsWritten).toBe(0);

    fs.writeFileSync(
      dump.checkpointPath,
      JSON.stringify({ dumpTimestamp: '2026-07-01 00:00:00', committedRows: 1 }),
    );
    await expect(
      importMusicBrainzArtists({
        dumpDir: dump.dumpDir,
        checkpointPath: dump.checkpointPath,
        batchSize: 100,
      }),
    ).rejects.toThrow(/2026-07-01/);
  });

  it('names the missing table when one is absent', async () => {
    const dump = makeDump();
    fs.rmSync(path.join(dump.dumpDir, 'artist_alias'));
    await expect(
      importMusicBrainzArtists({
        dumpDir: dump.dumpDir,
        checkpointPath: dump.checkpointPath,
        batchSize: 100,
      }),
    ).rejects.toThrow(/artist_alias/);
  });
});
