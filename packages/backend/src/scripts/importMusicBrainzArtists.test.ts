/**
 * The MusicBrainz artist importer, and the enrichment it exists to feed.
 *
 * Three things here go beyond "the rows land":
 *
 *  - `starvation is closed` drives `enrichArtistProfile` — the real reader —
 *    across the import, with Wikidata silenced so the mirror is the only source
 *    that can answer. Before the import it reports `nothing-found`; that is the
 *    confident negative this script exists to stop.
 *  - `urls` is no longer an embedded array but a child table keyed on
 *    `(artist_id, position)`, so ORDER and REPLACEMENT are both testable and
 *    both matter: `urlFor` takes the first relationship of a type.
 *  - `drops a URL the newer dump no longer states` is the fixture that tells a
 *    wholesale replacement from a merge. Every other fixture re-imports the same
 *    URLs, and cannot tell the two apart.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { asc, eq } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import {
  installCatalogImageMirrorMockForTests,
  resetCatalogImageMirror,
} from '../test/catalogImageMirror';
import { getDb } from '../db/postgres';
import { catalogEntities, musicbrainzArtists, musicbrainzArtistUrls } from '../db/schema/catalog';
import { setEnrichmentFetchForTests } from '../services/uploads/enrichmentHttp';
import { enrichArtistProfile } from '../services/uploads/enrichCatalogEntity';
import { importMusicBrainzArtists } from './importMusicBrainzArtists';

beforeAll(connectDb);
afterEach(async () => {
  setEnrichmentFetchForTests();
  resetCatalogImageMirror();
  await clearDb();
});
afterAll(disconnectDb);

const DUMP_TIMESTAMP = '2026-08-01 00:22:50';
const BEATLES_MBID = 'b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d';
const STONES_MBID = 'c8b03190-306c-4120-bb0b-6f2ebfc06ea9';

async function readArtist(mbid: string) {
  const [row] = await getDb()
    .select()
    .from(musicbrainzArtists)
    .where(eq(musicbrainzArtists.mbid, mbid))
    .limit(1);
  return row;
}

/** The child table, in the order `enrichCatalogEntity` reads it back. */
async function readUrls(mbid: string) {
  const artist = await readArtist(mbid);
  if (!artist) return [];
  return getDb()
    .select({
      position: musicbrainzArtistUrls.position,
      type: musicbrainzArtistUrls.type,
      url: musicbrainzArtistUrls.url,
    })
    .from(musicbrainzArtistUrls)
    .where(eq(musicbrainzArtistUrls.musicbrainzArtistId, artist.id))
    .orderBy(asc(musicbrainzArtistUrls.position));
}

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
      `2\t${STONES_MBID}\tThe Rolling Stones\tRolling Stones, The\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N\t2\t221\t\\N\t\\N\t0\t2026-01-01\tf\t\\N\t\\N`,
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
    link: [
      '900\t179\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N\t0\t2026-01-01\tf',
      '901\t180\t\\N\t\\N\t\\N\t\\N\t\\N\t\\N\t0\t2026-01-01\tf',
    ],
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

function importOptions(dump: { dumpDir: string; checkpointPath: string }, overrides = {}) {
  return {
    dumpDir: dump.dumpDir,
    checkpointPath: dump.checkpointPath,
    batchSize: 100,
    ...overrides,
  };
}

describe('importMusicBrainzArtists', () => {
  it('imports the artist identity keyed by MBID', async () => {
    const dump = makeDump();
    const summary = await importMusicBrainzArtists(importOptions(dump));

    expect(summary.artistRowsRead).toBe(2);
    expect(summary.rowsWritten).toBe(2);

    const beatles = await readArtist(BEATLES_MBID);
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
    await importMusicBrainzArtists(importOptions(dump));

    const beatles = await readArtist(BEATLES_MBID);
    expect(beatles?.beginDate).toBe('1960');
    expect(beatles?.endDate).toBe('1970-04-10');
  });

  it('resolves the area to a name and an ISO country code', async () => {
    const dump = makeDump();
    await importMusicBrainzArtists(importOptions(dump));

    const beatles = await readArtist(BEATLES_MBID);
    expect(beatles?.areaName).toBe('United Kingdom');
    expect(beatles?.countryCode).toBe('GB');
  });

  it('collects aliases without duplicating one written in two locales', async () => {
    const dump = makeDump();
    await importMusicBrainzArtists(importOptions(dump));

    const beatles = await readArtist(BEATLES_MBID);
    expect([...(beatles?.aliases ?? [])].sort()).toEqual(['Beatles', 'The Fab Four']);
  });

  /**
   * The four-table join. The relationship TYPE is what makes a URL useful —
   * "official homepage" belongs on a profile and a Discogs page does not, and
   * the URL alone cannot tell you which is which.
   */
  it('joins URL relationships through link → link_type to keep their meaning', async () => {
    const dump = makeDump();
    await importMusicBrainzArtists(importOptions(dump));

    const urls = await readUrls(BEATLES_MBID);
    expect(urls).toContainEqual({
      position: 0,
      type: 'official homepage',
      url: 'https://thebeatles.com',
    });
    expect(urls).toContainEqual({
      position: 1,
      type: 'discogs',
      url: 'https://www.discogs.com/artist/82730',
    });
  });

  /**
   * `position` is what the embedded array's index used to be, and it is
   * load-bearing: `enrichCatalogEntity` orders by it and takes the FIRST
   * relationship of a type. An implementation that wrote positions in an
   * arbitrary order would put a Discogs page where the homepage belongs.
   */
  it('numbers URL positions from zero in the order the dump joined them', async () => {
    const dump = makeDump();
    await importMusicBrainzArtists(importOptions(dump));

    expect((await readUrls(BEATLES_MBID)).map((row) => row.position)).toEqual([0, 1]);
  });

  it('writes no URL rows for an artist who has none', async () => {
    const dump = makeDump();
    await importMusicBrainzArtists(importOptions(dump));

    expect(await readUrls(STONES_MBID)).toEqual([]);
  });

  it('leaves absent fields null rather than writing empty strings', async () => {
    const dump = makeDump();
    await importMusicBrainzArtists(importOptions(dump));

    const stones = await readArtist(STONES_MBID);
    // Nullable COLUMNS now, where Mongo simply had no key.
    expect(stones?.beginDate).toBeNull();
    expect(stones?.endDate).toBeNull();
    expect(stones?.disambiguation).toBeNull();
    expect(stones?.isni).toBeNull();
    expect(stones?.ended).toBe(false);
    expect(stones?.aliases).toEqual([]);
  });

  it('is idempotent and updates in place', async () => {
    const dump = makeDump();
    const options = importOptions(dump);
    await importMusicBrainzArtists(options);
    const first = await readArtist(BEATLES_MBID);

    fs.rmSync(dump.checkpointPath);
    await importMusicBrainzArtists(options);
    const second = await readArtist(BEATLES_MBID);

    expect(await getDb().select().from(musicbrainzArtists)).toHaveLength(2);
    expect(second?.id).toBe(first?.id ?? '');
    // The child rows were replaced, not appended — two imports, still two URLs.
    expect(await readUrls(BEATLES_MBID)).toHaveLength(2);
  });

  /**
   * The fixture that tells REPLACEMENT from MERGE.
   *
   * Under Mongo the whole `urls` array was one `$set`, so a URL removed upstream
   * disappeared for free. Here the children are separate rows, and an
   * implementation that only inserted (or upserted on `(artist_id, position)`)
   * would leave the withdrawn relationship behind forever — with `position 1`
   * still occupied, so it would not even collide.
   *
   * Verified by mutation: removing the `DELETE` statement from the flush fails
   * this test AND `is idempotent and updates in place` — the latter only because
   * it asserts the URL count after a second import, which is the same property
   * seen from the other side. The other twelve tests stay green, which is the
   * part worth knowing: nothing else in this file can see the difference.
   */
  it('drops a URL the newer dump no longer states', async () => {
    const dump = makeDump();
    const options = importOptions(dump);
    await importMusicBrainzArtists(options);
    expect(await readUrls(BEATLES_MBID)).toHaveLength(2);

    // The Discogs relationship is withdrawn upstream.
    fs.writeFileSync(
      path.join(dump.dumpDir, 'l_artist_url'),
      '1\t900\t1\t500\t0\t2026-01-01\t0\t\\N\t\\N\n',
    );
    fs.rmSync(dump.checkpointPath);
    await importMusicBrainzArtists(options);

    const urls = await readUrls(BEATLES_MBID);
    expect(urls).toHaveLength(1);
    expect(urls[0]?.type).toBe('official homepage');
  });

  it('resumes from the checkpoint and refuses one from another dump', async () => {
    const dump = makeDump();
    fs.writeFileSync(
      dump.checkpointPath,
      JSON.stringify({ dumpTimestamp: DUMP_TIMESTAMP, committedRows: 2 }),
    );
    const summary = await importMusicBrainzArtists(importOptions(dump));
    expect(summary.skippedResumed).toBe(2);
    expect(summary.rowsWritten).toBe(0);

    fs.writeFileSync(
      dump.checkpointPath,
      JSON.stringify({ dumpTimestamp: '2026-07-01 00:00:00', committedRows: 1 }),
    );
    await expect(importMusicBrainzArtists(importOptions(dump))).rejects.toThrow(/2026-07-01/);
  });

  it('names the missing table when one is absent', async () => {
    const dump = makeDump();
    fs.rmSync(path.join(dump.dumpDir, 'artist_alias'));
    await expect(importMusicBrainzArtists(importOptions(dump))).rejects.toThrow(/artist_alias/);
  });
});

/**
 * The reason this script was pulled out of Task 19.
 *
 * `enrichCatalogEntity` reads the MusicBrainz mirror and this importer is the
 * only thing that fills it. Wikidata is silenced throughout so the mirror is the
 * ONLY source that can answer — otherwise a passing test would prove nothing
 * about this script.
 */
describe('importMusicBrainzArtists — the starvation it closes', () => {
  /** Every enrichment HTTP call answers "I have nothing", leaving only the mirror. */
  function silenceTheNetwork(): void {
    installCatalogImageMirrorMockForTests();
    setEnrichmentFetchForTests(async () => undefined);
  }

  async function makeArtistWithMbid(mbid: string): Promise<string> {
    const [artist] = await getDb()
      .insert(catalogEntities)
      .values({
        type: 'artist',
        name: 'The Beatles',
        nameKey: 'the beatles',
        source: 'upload',
        externalMusicbrainzArtistId: mbid,
      })
      .returning({ id: catalogEntities.id });
    if (!artist) throw new Error('makeArtistWithMbid: insert returned no row');
    return artist.id;
  }

  it('enrichArtistProfile finds nothing before the import and enriches after it', async () => {
    silenceTheNetwork();
    const artistId = await makeArtistWithMbid(BEATLES_MBID);

    const before = await enrichArtistProfile(artistId);
    // Not "skipped" — the artist exists and carries a verified MBID. The mirror
    // is simply empty, and the reason says so in the words an operator would
    // have to read to discover this script had never been run.
    expect(before.status).toBe('nothing-found');
    expect(before.fieldsWritten).toEqual([]);
    expect(before.reason).toContain(BEATLES_MBID);

    const dump = makeDump();
    await importMusicBrainzArtists(importOptions(dump));

    const after = await enrichArtistProfile(artistId);
    expect(after.status).toBe('enriched');
    expect(after.fieldsWritten.length).toBeGreaterThan(0);
  });

  it('still finds nothing for an MBID the dump never mentioned', async () => {
    silenceTheNetwork();
    const dump = makeDump();
    await importMusicBrainzArtists(importOptions(dump));

    // A loaded mirror must not start answering for artists it does not hold.
    const artistId = await makeArtistWithMbid('00000000-0000-4000-8000-000000000000');
    expect((await enrichArtistProfile(artistId)).status).toBe('nothing-found');
  });
});
