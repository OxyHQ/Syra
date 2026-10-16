/**
 * Every place a Syra row points at an image — the ONE list both halves of the
 * reference bookkeeping are built from.
 *
 * Oxy only keeps an application's file while the application says it uses it
 * (OxyHQ/oxy ADR 0043 D4/D5): an application-owned file nobody references goes
 * to the trash after 24 hours. So every use has to reach Oxy:
 *
 * - At write time, by the triggers of migration `0034_oxy_file_reference_triggers`,
 *   which queue an `add`/`remove` in `oxy_file_reference_ops` in the transaction
 *   of the row that changed. Each trigger's arguments are the `entityType`, `via`
 *   and `columns` below; `referenceRegistry.realdb.test.ts` reads them back from
 *   `pg_trigger` and fails if the two lists ever disagree.
 * - Nightly, by `referenceReconcile.ts`, whose inventory query is generated from
 *   this list ({@link inventoryQuery}).
 *
 * `via: 'image_assets'` columns hold `image_assets` ids (resolved to the row's
 * `oxy_file_id`); `via: 'file'` columns hold Oxy file ids directly. A column
 * holding a JSON array is a list of artist photo suggestions, each naming an
 * `image_assets` id at `image.url`.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { OxyReferenceEntityType } from '../../db/schema/oxyFiles';

export interface ReferenceSource {
  readonly entityType: OxyReferenceEntityType;
  /** The SQL table whose `id` is the reference's entity id. */
  readonly table: string;
  readonly via: 'image_assets' | 'file';
  /** SQL column names, in the order the trigger is created with. */
  readonly columns: readonly string[];
}

const SIZES = ['small', 'medium', 'large', 'xlarge', 'xxlarge', 'original'] as const;

/** A primary image column and its six per-size siblings. */
function imageColumns(primary: string, sizePrefix: string): string[] {
  return [primary, ...SIZES.map((size) => `${sizePrefix}_${size}_id`)];
}

export const REFERENCE_SOURCES: readonly ReferenceSource[] = [
  {
    entityType: 'catalog_entity',
    table: 'catalog_entities',
    via: 'image_assets',
    columns: [...imageColumns('image_id', 'image_sizes'), 'image_suggestions'],
  },
  {
    entityType: 'album',
    table: 'albums',
    via: 'image_assets',
    columns: imageColumns('cover_art_id', 'cover_art_sizes'),
  },
  {
    entityType: 'track',
    table: 'tracks',
    via: 'image_assets',
    columns: imageColumns('cover_art_id', 'cover_art_sizes'),
  },
  {
    entityType: 'user_upload',
    table: 'user_uploads',
    via: 'image_assets',
    columns: imageColumns('cover_art_id', 'cover_art_sizes'),
  },
  {
    entityType: 'playlist',
    table: 'playlists',
    via: 'image_assets',
    columns: imageColumns('cover_art_id', 'cover_art_sizes'),
  },
  {
    entityType: 'podcast',
    table: 'podcasts',
    via: 'image_assets',
    columns: imageColumns('image_id', 'image_sizes'),
  },
  {
    entityType: 'episode',
    table: 'episodes',
    via: 'image_assets',
    columns: imageColumns('image_id', 'image_sizes'),
  },
  {
    entityType: 'house',
    table: 'houses',
    via: 'file',
    columns: ['avatar_file_id', 'cover_image_file_id'],
  },
  { entityType: 'room', table: 'rooms', via: 'file', columns: ['stream_image_file_id'] },
  { entityType: 'series', table: 'series', via: 'file', columns: ['cover_image_file_id'] },
];

/** The one column in the list that holds a JSON array of suggestions rather than an id. */
export const SUGGESTIONS_COLUMN = 'image_suggestions';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): SQL {
  if (!IDENTIFIER.test(name)) throw new Error(`Not a plain SQL identifier: ${name}`);
  return sql.raw(`"${name}"`);
}

export function referenceSource(entityType: OxyReferenceEntityType): ReferenceSource {
  const source = REFERENCE_SOURCES.find((candidate) => candidate.entityType === entityType);
  if (!source) throw new Error(`No reference source for ${entityType}`);
  return source;
}

/**
 * One page of `{ fileId, entityId }` pairs Syra uses for `source`'s entity type,
 * for entities whose id is after `afterEntityId` — keyset-paginated by entity
 * id, so the nightly inventory streams a table of any size.
 *
 * The same resolution the triggers apply: the `image_assets` ids a row names
 * (every column, and every suggestion's `image.url`) mapped to their
 * `oxy_file_id`; a `via: 'file'` row's ids as they are.
 */
export function inventoryQuery(
  source: ReferenceSource,
  afterEntityId: string | null,
  limit: number,
): SQL {
  const table = ident(source.table);
  const idColumns = source.columns.filter((column) => column !== SUGGESTIONS_COLUMN);
  const values = sql.join(
    idColumns.map((column) => sql`e.${ident(column)}`),
    sql`, `,
  );
  const suggestions = source.columns.includes(SUGGESTIONS_COLUMN)
    ? sql`union all select s -> 'image' ->> 'url'
          from jsonb_array_elements(
            case when jsonb_typeof(e.${ident(SUGGESTIONS_COLUMN)}) = 'array'
                 then e.${ident(SUGGESTIONS_COLUMN)} else '[]'::jsonb end
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

/** The last entity id of a page, to continue after it; `null` when the table is exhausted. */
export function lastEntityIdOfPage(
  source: ReferenceSource,
  afterEntityId: string | null,
  limit: number,
): SQL {
  const table = ident(source.table);
  return sql`
    select max(id) as "lastId", count(*)::int as "count" from (
      select e.id from ${table} e
      ${afterEntityId === null ? sql`` : sql`where e.id > ${afterEntityId}`}
      order by e.id
      limit ${limit}
    ) page
  `;
}
