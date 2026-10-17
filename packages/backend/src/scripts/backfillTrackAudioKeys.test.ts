import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { backfillTrackAudioKeys, type TrackKeyLine } from './backfillTrackAudioKeys';

/**
 * Finding a track's original by its file name: a track that kept its artist and
 * album, one an artist split moved, one whose object is gone, one named twice —
 * and a row that already knows its key, which is never touched.
 */

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

let bucket: string[];
const listKeys = async function* () {
  yield* bucket;
};

beforeEach(async () => {
  await getDb().execute(sql`
    insert into catalog_entities (id, type, name, name_key, source)
    values ('ce-old', 'artist', 'Old', 'old', 'upload'), ('ce-new', 'artist', 'New', 'new', 'upload')
  `);
  await getDb().execute(sql`
    insert into tracks (id, title, artist_id, artist_name, duration, source, audio_source_url, audio_source_format, audio_source_key)
    values
      ('t-kept', 'T', 'ce-new', 'New', 1, 'upload', '/api/audio/t-kept', 'mp3', null),
      ('t-split', 'T', 'ce-new', 'New', 1, 'upload', '/api/audio/t-split', 'mp3', null),
      ('t-gone', 'T', 'ce-new', 'New', 1, 'upload', '/api/audio/t-gone', 'mp3', null),
      ('t-twice', 'T', 'ce-new', 'New', 1, 'upload', '/api/audio/t-twice', 'mp3', null),
      ('t-known', 'T', 'ce-new', 'New', 1, 'upload', '/api/audio/t-known', 'mp3', 'audio/elsewhere/t-known.mp3'),
      ('t-processing', 'T', 'ce-new', 'New', 1, 'upload', null, null, null)
  `);
  bucket = [
    'audio/ce-new/t-kept.mp3',
    // Uploaded under the merged artist, re-pointed by splitMergedArtist since.
    'audio/ce-old/album-1/t-split.mp3',
    'audio/ce-new/t-twice.mp3',
    'audio/ce-old/t-twice.flac',
    'audio/ce-new/t-known.mp3',
    'audio/stray.txt',
  ];
});

async function keys(): Promise<Record<string, string | null>> {
  const rows = await getDb().execute<{ id: string; key: string | null }>(
    sql`select id, audio_source_key as key from tracks order by id`,
  );
  return Object.fromEntries([...rows].map((row) => [row.id, row.key]));
}

describe('backfillTrackAudioKeys', () => {
  it('previews by file name and writes nothing', async () => {
    const lines: TrackKeyLine[] = [];
    const stats = await backfillTrackAudioKeys({
      apply: false,
      listKeys,
      report: (l) => lines.push(l),
    });
    expect(stats).toEqual({ would_record: 2, recorded: 0, missing: 1, ambiguous: 1 });
    expect(lines.find((line) => line.id === 't-split')).toEqual({
      id: 't-split',
      outcome: 'would_record',
      moved: true,
    });
    expect(lines.find((line) => line.id === 't-kept')?.moved).toBe(false);
    expect((await keys())['t-split']).toBeNull();
  });

  it('records where each original IS, even after its artist changed, and nothing it cannot prove', async () => {
    await backfillTrackAudioKeys({ apply: true, listKeys });
    expect(await keys()).toEqual({
      't-gone': null,
      't-kept': 'audio/ce-new/t-kept.mp3',
      't-known': 'audio/elsewhere/t-known.mp3',
      't-processing': null,
      't-split': 'audio/ce-old/album-1/t-split.mp3',
      't-twice': null,
    });
    const again = await backfillTrackAudioKeys({ apply: true, listKeys });
    expect(again.recorded).toBe(0);
  });
});
