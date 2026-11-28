import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { sql, type SQL } from 'drizzle-orm';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { OXY_REFERENCE_ENTITY_TYPES, type OxyReferenceEntityType } from '../../db/schema/oxyFiles';
import {
  inventoryQuery,
  lastEntityIdOfPage,
  REFERENCE_SOURCES,
  type ReferenceSource,
  SUGGESTIONS_COLUMN,
} from './referenceRegistry';
import { referenceInventory } from './referenceReconcile';

/**
 * The reference bookkeeping has two halves built from one list:
 * `REFERENCE_SOURCES` (TypeScript, the nightly inventory) and the triggers of
 * migration `0034` (SQL, every write). These tests hold them equal — against
 * `pg_trigger` itself — and then drive every source through a real write to
 * prove the trigger and the inventory resolve the same files.
 */

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

type Op = {
  file_id: string;
  entity_type: string;
  entity_id: string;
  op: 'add' | 'remove';
};

async function ops(): Promise<Op[]> {
  return [
    ...(await getDb().execute<Op>(sql`
      select file_id, entity_type, entity_id, op from oxy_file_reference_ops
      order by entity_type, entity_id, file_id
    `)),
  ];
}

async function image(id: string, fileId: string): Promise<void> {
  await getDb().execute(sql`
    insert into image_assets (id, oxy_file_id, filename, content_type, byte_size, owner_type)
    values (${id}, ${fileId}, 'f', 'image/png', 1, 'upload')
  `);
}

describe('the triggers and REFERENCE_SOURCES are one list', () => {
  it('has exactly one trigger per source, created with its entity type, resolution and columns', async () => {
    const rows = [
      ...(await getDb().execute<{ table: string; trigger: string; args: string }>(sql`
        select c.relname as "table", t.tgname as "trigger", encode(t.tgargs, 'escape') as args
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where t.tgname in ('oxy_file_references', 'oxy_audio_file_references')
          and not t.tgisinternal
      `)),
    ];
    const actual = Object.fromEntries(
      rows.map((row) => [
        `${row.table}:${row.trigger}`,
        row.args.split('\\000').filter((arg) => arg.length > 0),
      ]),
    );
    const expected = Object.fromEntries(
      REFERENCE_SOURCES.map((source) => [
        `${source.table}:${source.trigger}`,
        [source.entityType, source.via, ...source.columns],
      ]),
    );
    expect(actual).toEqual(expected);
  });

  it('covers every entity type the outbox CHECK admits, once', () => {
    expect(REFERENCE_SOURCES.map((source) => source.entityType).sort()).toEqual(
      [...OXY_REFERENCE_ENTITY_TYPES].sort(),
    );
  });
});

/** One row of every table that can point at an image, each using `fileFor(type)`. */
async function seedEveryEntity(): Promise<Record<OxyReferenceEntityType, string>> {
  const db = getDb();
  await image('img-ce', 'F-catalog_entity');
  await image('img-ce-suggestion', 'F-suggestion');
  await image('img-album', 'F-album');
  await image('img-track', 'F-track');
  await image('img-upload', 'F-user_upload');
  await image('img-playlist', 'F-playlist');
  await image('img-podcast', 'F-podcast');
  await image('img-episode', 'F-episode');
  await db.execute(sql`
    insert into catalog_entities (id, type, name, name_key, source, image_id, image_suggestions)
    values ('ce-1', 'artist', 'A', 'a', 'upload', 'img-ce',
      ${JSON.stringify([{ image: { origin: 'upload', url: 'img-ce-suggestion' } }])}::jsonb)
  `);
  await db.execute(sql`
    insert into albums (id, title, artist_id, artist_name, release_date, cover_art_id)
    values ('album-1', 'Al', 'ce-1', 'A', '2026', 'img-album')
  `);
  await db.execute(sql`
    insert into tracks (id, title, artist_id, artist_name, duration, source, cover_art_sizes_small_id, audio_file_id)
    values ('track-1', 'T', 'ce-1', 'A', 1, 'upload', 'img-track', 'F-track_audio')
  `);
  await db.execute(sql`
    insert into user_uploads (id, owner_oxy_user_id, title, duration, size_bytes, sha256, cover_art_id, audio_file_id)
    values ('upload-1', 'u', 'U', 1, 1, ${'a'.repeat(64)}, 'img-upload', 'F-user_upload_audio')
  `);
  await db.execute(sql`
    insert into playlists (id, name, owner_oxy_user_id, owner_username, cover_art_id)
    values ('playlist-1', 'P', 'u', 'u', 'img-playlist')
  `);
  await db.execute(sql`
    insert into podcasts (id, title, source, image_sizes_large_id)
    values ('podcast-1', 'Pod', 'syra', 'img-podcast')
  `);
  await db.execute(sql`
    insert into episodes (id, podcast_id, podcast_title, title, guid, pub_date, source, image_id, audio_file_id)
    values ('episode-1', 'podcast-1', 'Pod', 'E', 'g', now(), 'syra', 'img-episode', 'F-episode_audio')
  `);
  await db.execute(sql`
    insert into houses (id, name, created_by, avatar_file_id, cover_image_file_id)
    values ('house-1', 'H', 'u', 'F-house', 'F-house')
  `);
  await db.execute(sql`
    insert into rooms (id, title, host, stream_image_file_id) values ('room-1', 'R', 'u', 'F-room')
  `);
  await db.execute(sql`
    insert into series (id, title, created_by, recurrence_type, recurrence_time, room_template_title_pattern, cover_image_file_id)
    values ('series-1', 'S', 'u', 'weekly', '10:00', 'x', 'F-series')
  `);
  await db.execute(sql`
    insert into recordings (id, room_title, host, egress_id, object_key, started_at, expires_at, oxy_file_id)
    values ('recording-1', 'R', 'u', 'egress-1', 'oxy/recording-1.ogg', now(), now(), 'F-recording')
  `);
  return {
    catalog_entity: 'ce-1',
    album: 'album-1',
    track: 'track-1',
    user_upload: 'upload-1',
    playlist: 'playlist-1',
    podcast: 'podcast-1',
    episode: 'episode-1',
    house: 'house-1',
    room: 'room-1',
    series: 'series-1',
    track_audio: 'track-1',
    user_upload_audio: 'upload-1',
    episode_audio: 'episode-1',
    recording: 'recording-1',
  };
}

describe('every write queues the files it starts or stops using', () => {
  it('queues an add for each entity on insert — a file named twice by one row is ONE reference', async () => {
    await seedEveryEntity();
    expect(await ops()).toEqual([
      { file_id: 'F-album', entity_type: 'album', entity_id: 'album-1', op: 'add' },
      { file_id: 'F-catalog_entity', entity_type: 'catalog_entity', entity_id: 'ce-1', op: 'add' },
      { file_id: 'F-suggestion', entity_type: 'catalog_entity', entity_id: 'ce-1', op: 'add' },
      { file_id: 'F-episode', entity_type: 'episode', entity_id: 'episode-1', op: 'add' },
      {
        file_id: 'F-episode_audio',
        entity_type: 'episode_audio',
        entity_id: 'episode-1',
        op: 'add',
      },
      { file_id: 'F-house', entity_type: 'house', entity_id: 'house-1', op: 'add' },
      { file_id: 'F-playlist', entity_type: 'playlist', entity_id: 'playlist-1', op: 'add' },
      { file_id: 'F-podcast', entity_type: 'podcast', entity_id: 'podcast-1', op: 'add' },
      { file_id: 'F-recording', entity_type: 'recording', entity_id: 'recording-1', op: 'add' },
      { file_id: 'F-room', entity_type: 'room', entity_id: 'room-1', op: 'add' },
      { file_id: 'F-series', entity_type: 'series', entity_id: 'series-1', op: 'add' },
      { file_id: 'F-track', entity_type: 'track', entity_id: 'track-1', op: 'add' },
      { file_id: 'F-track_audio', entity_type: 'track_audio', entity_id: 'track-1', op: 'add' },
      { file_id: 'F-user_upload', entity_type: 'user_upload', entity_id: 'upload-1', op: 'add' },
      {
        file_id: 'F-user_upload_audio',
        entity_type: 'user_upload_audio',
        entity_id: 'upload-1',
        op: 'add',
      },
    ]);
  });

  it("keeps a row's audio and its images apart: letting go of one never touches the other", async () => {
    await seedEveryEntity();
    await getDb().execute(sql`update tracks set audio_file_id = null where id = 'track-1'`);
    const after = await ops();
    expect(after.find((op) => op.entity_type === 'track_audio')).toMatchObject({ op: 'remove' });
    expect(after.find((op) => op.entity_type === 'track')).toMatchObject({ op: 'add' });

    await getDb().execute(sql`delete from recordings where id = 'recording-1'`);
    expect((await ops()).find((op) => op.entity_type === 'recording')).toMatchObject({
      op: 'remove',
    });
  });

  it('turns an add into a remove when the row lets go, keeping one intent per key', async () => {
    await seedEveryEntity();
    await getDb().execute(sql`update houses set avatar_file_id = null where id = 'house-1'`);
    // Still the cover: nothing changes for the house.
    expect((await ops()).find((op) => op.entity_type === 'house')?.op).toBe('add');

    await getDb().execute(sql`update houses set cover_image_file_id = null where id = 'house-1'`);
    await getDb().execute(sql`delete from rooms where id = 'room-1'`);
    const after = await ops();
    expect(after.find((op) => op.entity_type === 'house')).toMatchObject({ op: 'remove' });
    expect(after.find((op) => op.entity_type === 'room')).toMatchObject({ op: 'remove' });
    expect(after.filter((op) => op.entity_type === 'house')).toHaveLength(1);
  });

  it('moves every reference when an image is repointed to another file (a repair)', async () => {
    await image('img-r', 'F-new');
    await getDb().execute(sql`
      insert into playlists (id, name, owner_oxy_user_id, owner_username, cover_art_id)
      values ('playlist-2', 'P', 'u', 'u', 'img-r')
    `);
    await getDb().execute(sql`
      insert into catalog_entities (id, type, name, name_key, source, image_suggestions)
      values ('ce-2', 'artist', 'B', 'b', 'upload',
        ${JSON.stringify([{ image: { origin: 'upload', url: 'img-r' } }])}::jsonb)
    `);
    expect(await ops()).toEqual([
      { file_id: 'F-new', entity_type: 'catalog_entity', entity_id: 'ce-2', op: 'add' },
      { file_id: 'F-new', entity_type: 'playlist', entity_id: 'playlist-2', op: 'add' },
    ]);

    // Repointed again (a repair): the old file is let go, the new one taken.
    await getDb().execute(sql`update image_assets set oxy_file_id = 'F-newer' where id = 'img-r'`);
    const after = await ops();
    expect(after.filter((op) => op.file_id === 'F-new').map((op) => op.op)).toEqual([
      'remove',
      'remove',
    ]);
    expect(after.filter((op) => op.file_id === 'F-newer').map((op) => op.op)).toEqual([
      'add',
      'add',
    ]);
  });

  it('keeps a file an entity still uses through another image when one of its images is repointed', async () => {
    await image('a', 'F-shared');
    await image('b', 'F-shared');
    await getDb().execute(sql`
      insert into playlists (id, name, owner_oxy_user_id, owner_username, cover_art_id, cover_art_sizes_small_id)
      values ('playlist-3', 'P', 'u', 'u', 'a', 'b')
    `);
    await getDb().execute(sql`delete from oxy_file_reference_ops`);
    await getDb().execute(sql`update image_assets set oxy_file_id = 'F-other' where id = 'a'`);
    expect(await ops()).toEqual([
      { file_id: 'F-other', entity_type: 'playlist', entity_id: 'playlist-3', op: 'add' },
    ]);
  });
});

describe('the nightly inventory resolves exactly what the triggers queued', () => {
  it('lists, per entity type, the pairs the inserts queued as adds', async () => {
    await seedEveryEntity();
    const queued = await ops();
    for (const entityType of OXY_REFERENCE_ENTITY_TYPES) {
      const inventory: Array<{ fileId: string; entityId: string }> = [];
      for await (const item of referenceInventory(entityType, 1)) inventory.push(item);
      const expected = queued
        .filter((op) => op.entity_type === entityType)
        .map((op) => ({ fileId: op.file_id, entityId: op.entity_id }));
      expect(inventory.sort((a, b) => a.fileId.localeCompare(b.fileId))).toEqual(
        expected.sort((a, b) => a.fileId.localeCompare(b.fileId)),
      );
    }
  });

  it('pages through a table by entity id without skipping or repeating', async () => {
    for (let i = 0; i < 7; i += 1) {
      await getDb().execute(sql`
        insert into houses (id, name, created_by, avatar_file_id) values (${`h-${i}`}, 'H', 'u', ${`F-${i}`})
      `);
    }
    const seen: string[] = [];
    for await (const item of referenceInventory('house', 3)) seen.push(item.entityId);
    expect(seen).toEqual(['h-0', 'h-1', 'h-2', 'h-3', 'h-4', 'h-5', 'h-6']);
  });
});

/**
 * The inventory page as it was written before it read its columns in the keyset
 * scan: the page's ids joined back to the table. Kept here to hold the two
 * forms equal.
 */
function joinedInventoryQuery(
  source: ReferenceSource,
  afterEntityId: string | null,
  limit: number,
): SQL {
  const col = (name: string) => sql.raw(`"${name}"`);
  const table = col(source.table);
  const values = sql.join(
    source.columns.filter((c) => c !== SUGGESTIONS_COLUMN).map((c) => sql`e.${col(c)}`),
    sql`, `,
  );
  const suggestions = source.columns.includes(SUGGESTIONS_COLUMN)
    ? sql`union all select s -> 'image' ->> 'url'
          from jsonb_array_elements(
            case when jsonb_typeof(e.${col(SUGGESTIONS_COLUMN)}) = 'array'
                 then e.${col(SUGGESTIONS_COLUMN)} else '[]'::jsonb end
          ) s`
    : sql``;
  const page = sql`
    select e.id from ${table} e
    ${afterEntityId === null ? sql`` : sql`where e.id > ${afterEntityId}`}
    order by e.id
    limit ${limit}
  `;
  if (source.via === 'file') {
    return sql`
      with page as (${page})
      select distinct v.value as "fileId", e.id as "entityId"
      from page p
      join ${table} e on e.id = p.id
      cross join lateral unnest(array[${values}]::text[]) as v(value)
      where v.value is not null
      order by e.id
    `;
  }
  return sql`
    with page as (${page})
    select distinct ia.oxy_file_id as "fileId", e.id as "entityId"
    from page p
    join ${table} e on e.id = p.id
    cross join lateral (
      select unnest(array[${values}]::text[]) as asset_id
      ${suggestions}
    ) v
    join image_assets ia on ia.id = v.asset_id
    where ia.oxy_file_id is not null
    order by e.id
  `;
}

type Pair = { fileId: string; entityId: string };

async function pairs(query: SQL): Promise<Pair[]> {
  return [...(await getDb().execute<Pair>(query))].map(({ fileId, entityId }) => ({
    fileId,
    entityId,
  }));
}

/** Pairs in entity order; within one entity, by file (DISTINCT fixes no order there). */
function canonical(page: Pair[]): Pair[] {
  for (let i = 1; i < page.length; i += 1) {
    const previous = page[i - 1];
    const current = page[i];
    if (previous && current) expect(previous.entityId <= current.entityId).toBe(true);
  }
  return [...page].sort(
    (a, b) => a.entityId.localeCompare(b.entityId) || a.fileId.localeCompare(b.fileId),
  );
}

describe('the inventory page reads its columns in the keyset scan', () => {
  it('returns, page by page, exactly what the page joined back to its table returned', async () => {
    await seedEveryEntity();
    const db = getDb();
    for (let i = 0; i < 6; i += 1) await image(`img-x${i}`, `F-x${i}`);
    // Rows with no image, one image under several columns, an image shared with
    // another row, and suggestions that are an array, a scalar and null.
    const episodeImages: (string | null)[][] = [
      [null, null, null],
      ['img-x0', 'img-x0', 'img-x1'],
      ['img-episode', null, 'img-x2'],
      [null, 'img-x3', null],
      ['img-x4', 'img-x5', 'img-x4'],
    ];
    for (const [i, [primary, small, original]] of episodeImages.entries()) {
      await db.execute(sql`
        insert into episodes (id, podcast_id, podcast_title, title, guid, pub_date, source,
          image_id, image_sizes_small_id, image_sizes_original_id, audio_file_id)
        values (${`episode-x${i}`}, 'podcast-1', 'Pod', 'E', ${`g-${i}`}, now(), 'syra',
          ${primary ?? null}, ${small ?? null}, ${original ?? null}, ${i % 2 === 0 ? `F-audio-${i}` : null})
      `);
    }
    const suggestions = [
      JSON.stringify([{ image: { url: 'img-x0' } }, { image: { url: 'img-x1' } }]),
      JSON.stringify({ image: { url: 'img-x2' } }),
      'null',
    ];
    for (const [i, value] of suggestions.entries()) {
      await db.execute(sql`
        insert into catalog_entities (id, type, name, name_key, source, image_id, image_suggestions)
        values (${`ce-x${i}`}, 'artist', 'A', ${`a-${i}`}, 'upload', ${i === 1 ? 'img-x3' : null}, ${value}::jsonb)
      `);
    }
    for (let i = 0; i < 4; i += 1) {
      await db.execute(sql`
        insert into houses (id, name, created_by, avatar_file_id, cover_image_file_id)
        values (${`house-x${i}`}, 'H', 'u', ${i === 0 ? null : `F-h${i}`}, ${i === 2 ? `F-h${i}` : null})
      `);
    }

    let pages = 0;
    for (const source of REFERENCE_SOURCES) {
      for (const pageSize of [1, 2, 3, 100]) {
        let after: string | null = null;
        for (;;) {
          const expected = await pairs(joinedInventoryQuery(source, after, pageSize));
          const actual = await pairs(inventoryQuery(source, after, pageSize));
          expect(canonical(actual)).toEqual(canonical(expected));
          pages += 1;
          const boundaries: { lastId: string | null; count: number }[] = [
            ...(await db.execute<{ lastId: string | null; count: number }>(
              lastEntityIdOfPage(source, after, pageSize),
            )),
          ];
          const page = boundaries[0];
          if (!page || page.count < pageSize || page.lastId === null) break;
          after = page.lastId;
        }
      }
    }
    expect(pages).toBeGreaterThan(REFERENCE_SOURCES.length * 4);
  });
});
