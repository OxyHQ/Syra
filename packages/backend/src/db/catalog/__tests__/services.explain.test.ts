/**
 * What the PLANNER does with the queries Task 10b's services issue.
 *
 * The sibling `containers.explain.test.ts` covers the container helpers Task
 * 10a shipped. This covers the queries the SERVICES run directly, and it exists
 * for the same reason and by the same method: a definition assertion checks what
 * was written down, and on this branch that difference has already shipped
 * twice.
 *
 * ## What it caught
 *
 * Every index on `tracks` except the primary key is PARTIAL on
 * `is_available = true and copyright_removed = false`, and Postgres uses a
 * partial index only when the query's predicate IMPLIES the index's. The two
 * artist-wide moderation queries fail that test in opposite directions:
 *
 *   - `strikeService.takeDownArtistTracks` filters
 *     `artist_id = $1 and copyright_removed = false` with NO `is_available`
 *     clause — deliberately, because terminating an artist has to mark their
 *     UNPUBLISHED tracks removed too.
 *   - the termination cascade in `takedown.takeDownTrack` filters
 *     `artist_id = $1 and copyright_removed = true`, the exact complement of
 *     every partial index on the table.
 *
 * Both were Seq Scans at 3,865 buffers and 48-70 ms against 40,000 seeded
 * tracks, on a write path that runs once per copyright strike. Migration `0017`
 * adds a plain `tracks_artist_id_idx` — the index `models/Track.ts:132` declares
 * and the port folded into a compound partial one — and both now read 136
 * buffers. This asserts the planner REACHES it: a definition check would pass on
 * the compound index too, which is exactly how the previous instance was
 * certified rather than caught.
 *
 * ## Seeding, rollback, and the control
 *
 * Everything runs inside ONE transaction that seeds a catalogue with real
 * cardinality, `ANALYZE`s, EXPLAINs, and ROLLS BACK — the cleanup is the
 * rollback, not a delete that could itself fail. On an empty table every partial
 * index has identical statistics and the planner's choice among them is a coin
 * flip.
 *
 * `set local enable_seqscan = off` forces the planner to prefer any index it
 * CAN use, so a remaining Seq Scan means no index could serve the query at all.
 * The control probe — a predicate no index covers — must still report one, or
 * "no Seq Scan" cannot be told from "stopped reading plans".
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb } from '../../postgres';

/** Thrown to roll the seeding transaction back once every plan is collected. */
class Rollback extends Error {}

/** Ids the seed writes, all carrying this prefix. Never committed. */
const MARKER = 'svc-explain';

const SEEDED_TRACKS = 40000;

/** Plan text by probe name, collected once in `beforeAll`. */
const plans = new Map<string, string>();

/** Rows actually visible in `tracks` inside the seeding transaction. */
let seededTrackCount = 0;

/**
 * The queries measured here, as hand-written SQL.
 *
 * NOT "the shipped SQL", which is what this said and could not support. These
 * are TRANSCRIPTIONS of what the services build with drizzle, and nothing binds
 * the two: a service query can drift out from under a green planner gate, which
 * is precisely the "a declaration is not a measurement" failure this file's own
 * doc comment is about. Stated plainly rather than fixed, because the fix is not
 * free — `containers.explain.test.ts` EXPLAINs the module's real exported
 * conditions and that is the better shape, but the queries below are assembled
 * inside service functions with no exported condition to reach for.
 *
 * What each transcription is worth: it proves an INDEX EXISTS AND IS REACHABLE
 * for a predicate of that shape. It does not prove the service still issues it.
 * When a service in this list changes its WHERE clause, change the probe with
 * it — there is no gate that will tell you.
 */
const PROBES: readonly { readonly name: string; readonly sql: string }[] = [
  {
    // `services/strikeService.ts` — `takeDownArtistTracks`.
    name: 'strikeTakedown',
    sql: `select id from tracks
          where artist_id = '${MARKER}-art-5' and copyright_removed = false`,
  },
  {
    // `services/compliance/takedown.ts` — the termination cascade.
    name: 'terminationCascade',
    sql: `select id from tracks
          where artist_id = '${MARKER}-art-5' and copyright_removed = true`,
  },
  {
    // `services/radio/radioSeed.ts` — `resolveArtistSeed`.
    name: 'artistSeedTracks',
    sql: `select id from tracks
          where artist_id = '${MARKER}-art-5' and is_available = true and copyright_removed = false
          order by popularity desc limit 10`,
  },
  {
    // `services/radio/radioSeed.ts` — `resolveAlbumSeed`.
    name: 'albumSeedTracks',
    sql: `select id from tracks
          where album_id = '${MARKER}-alb-5' and is_available = true and copyright_removed = false
          order by track_number asc limit 20`,
  },
  {
    // `services/radio/radioPools.ts` — `findPoolTracks`, the genre pool.
    name: 'radioGenrePool',
    sql: `select id from tracks
          where is_available = true and copyright_removed = false and genre in ('rock','pop')
          order by (cover_art_id is not null) desc, popularity desc, play_count desc limit 60`,
  },
  {
    // `services/catalog/artistProfile.ts` — `loadCreditedOn`.
    name: 'creditedOn',
    sql: `select t.id, c.role from tracks t
          join track_credits c on c.track_id = t.id
          where c.name_key = '${MARKER}-namekey-7' and t.artist_id <> '${MARKER}-art-5'
            and t.is_available = true and t.copyright_removed = false
          order by t.popularity desc, t.created_at desc limit 50`,
  },
  {
    // `services/uploads/matchCatalog.ts` — the Chromaprint candidate bucket.
    name: 'fingerprintBucket',
    sql: `select track_id from track_fingerprints
          where fingerprint_duration_sec between 196 and 202 limit 500`,
  },
  {
    // `db/catalog/hydrate.ts` — the per-page rendition counts behind
    // `previewAvailable`.
    name: 'hlsCounts',
    sql: `select track_id, count(*) from track_hls_renditions
          where track_id in ('${MARKER}-t-1','${MARKER}-t-2') group by track_id`,
  },
  {
    /**
     * The control. `tracks.comment` carries no index, so this MUST still report
     * a Seq Scan under `enable_seqscan = off`. Without it, every "no Seq Scan"
     * assertion above could equally mean the probe stopped reading plans.
     */
    name: 'control',
    sql: `select id from tracks where comment = 'nothing matches this'`,
  },
];

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

async function seed(tx: Tx): Promise<void> {
  await executeRows(tx, sql.raw(`
    insert into image_assets (id, s3_key, filename, content_type, byte_size, owner_type, width, height)
    select '${MARKER}-img-' || g, '${MARKER}/' || g, g || '.jpg', 'image/jpeg', 1000, 'album', 640, 640
    from generate_series(1, 600) g`));

  await executeRows(tx, sql.raw(`
    insert into catalog_entities (id, type, name, name_key, source, popularity, image_id, genres, terminated, stats_followers)
    select '${MARKER}-art-' || g, 'artist', '${MARKER} artist ' || g, '${MARKER}-artist' || g, 'upload', g % 101,
           case when g % 3 = 0 then '${MARKER}-img-' || g else null end,
           case g % 3 when 0 then array['rock','pop'] when 1 then array['jazz'] else array['ambient','hiphop'] end,
           case when g % 97 = 0 then true else false end, g % 500
    from generate_series(1, 300) g`));

  await executeRows(tx, sql.raw(`
    insert into albums (id, title, artist_id, artist_name, release_date, cover_art_id, popularity)
    select '${MARKER}-alb-' || g, 'Album ' || g, '${MARKER}-art-' || (1 + (g % 300)), 'Artist', '2020-01-01',
           '${MARKER}-img-' || (1 + (g % 600)), g % 101
    from generate_series(1, 600) g`));

  /**
   * Both removal states are represented, and that is what the two moderation
   * probes need: `copyright_removed = true` for one in 31 tracks and
   * `is_available = false` for one in 23, chosen coprime so the four
   * combinations all occur. A seed where every track is playable cannot tell a
   * partial index that serves a query from one that cannot.
   */
  await executeRows(tx, sql.raw(`
    insert into tracks (id, title, artist_id, artist_name, album_id, duration, source, status,
                        popularity, play_count, is_available, copyright_removed, is_explicit,
                        genre, mood, track_number, cover_art_id)
    select '${MARKER}-t-' || g, 'Track ' || g, '${MARKER}-art-' || (1 + (g % 300)), 'Artist',
           '${MARKER}-alb-' || (1 + (g % 600)), 150 + (g % 120), 'upload', 'ready', g % 101, g % 5000,
           case when g % 23 = 0 then false else true end,
           case when g % 31 = 0 then true else false end,
           case when g % 11 = 0 then true else false end,
           (array['rock','pop','jazz','ambient','hiphop'])[1 + (g % 5)],
           (array['chill','energetic','sad','happy'])[1 + (g % 4)],
           1 + (g % 12),
           case when g % 4 = 0 then '${MARKER}-img-' || (1 + (g % 600)) else null end
    from generate_series(1, ${SEEDED_TRACKS}) g`));

  await executeRows(tx, sql.raw(`
    insert into track_credits (id, track_id, position, name, role, name_key)
    select '${MARKER}-c-' || g, '${MARKER}-t-' || g, 0, 'Person ' || (g % 50), 'producer',
           '${MARKER}-namekey-' || (g % 50)
    from generate_series(1, 8000) g`));

  await executeRows(tx, sql.raw(`
    insert into track_fingerprints (id, track_id, fingerprint, fingerprint_duration_sec)
    select '${MARKER}-fp-' || g, '${MARKER}-t-' || g, array[1,2,3], 150 + (g % 120)
    from generate_series(1, 8000) g`));

  await executeRows(tx, sql.raw(`
    insert into track_hls_renditions (id, track_id, position, manifest_key, bitrate_kbps, encrypted)
    select '${MARKER}-r-' || g, '${MARKER}-t-' || (1 + (g % 20000)), g % 3, 'k', 96, true
    from generate_series(1, 20000) g`));

  await executeRows(tx, sql.raw(
    'analyze image_assets, catalog_entities, albums, tracks, track_credits, track_fingerprints, track_hls_renditions'
  ));

  const [counted] = await executeRows<{ total: number }>(
    tx, sql.raw(`select count(*)::int as total from tracks where id like '${MARKER}-%'`));
  seededTrackCount = counted?.total ?? 0;
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  await connectPostgres();

  try {
    await getDb().transaction(async (tx) => {
      await seed(tx);

      // `set local`, so the setting unwinds at rollback and cannot leak to
      // another suite sharing this pool even if a probe throws.
      await executeRows(tx, sql.raw('set local enable_seqscan = off'));

      for (const probe of PROBES) {
        const rows = await executeRows<{ 'QUERY PLAN': string }>(
          tx, sql.raw(`explain (analyze, buffers) ${probe.sql}`));
        plans.set(probe.name, rows.map((row) => row['QUERY PLAN']).join('\n'));
      }

      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
});

afterAll(closePostgres);

/** Index names the planner actually used, in the order they appear. */
function indexesIn(probe: string): string {
  const plan = plans.get(probe) ?? '';
  const names = [...plan.matchAll(/Index (?:Only )?Scan using (\w+)|Bitmap Index Scan on (\w+)/g)]
    .map((match) => match[1] ?? match[2]);
  return [...new Set(names)].join(', ');
}

describe('the seed is real', () => {
  it('inserted the tracks the plans were measured against', () => {
    // Not decoration: on a seed that inserted nothing, every plan below is a
    // measurement of an empty table and every "no Seq Scan" assertion passes
    // for the wrong reason.
    expect(seededTrackCount).toBe(SEEDED_TRACKS);
  });

  it('the control still reports a table scan under enable_seqscan = off', () => {
    expect(plans.get('control')).toContain('Seq Scan on tracks');
  });
});

describe('the artist-wide moderation queries reach migration 0017 index', () => {
  /**
   * Named in the assertion so a regression reports WHICH index the planner
   * chose. Both of these were Seq Scans before `tracks_artist_id_idx` existed —
   * that is the mutation, and it was run: dropping the index returns both to
   * `Seq Scan on tracks`.
   */
  it('taking down an artist every track does not scan the table', () => {
    expect(plans.get('strikeTakedown')).not.toContain('Seq Scan on tracks');
    expect(`strike takedown: ${indexesIn('strikeTakedown')}`).toBe(
      'strike takedown: tracks_artist_id_idx'
    );
  });

  it('the termination cascade over already-removed tracks does not scan the table', () => {
    // The complement predicate — `copyright_removed = true` — which NO partial
    // index on this table can ever serve, whatever else is added later.
    expect(plans.get('terminationCascade')).not.toContain('Seq Scan on tracks');
    expect(`termination cascade: ${indexesIn('terminationCascade')}`).toBe(
      'termination cascade: tracks_artist_id_idx'
    );
  });
});

describe('the service read paths reach an index', () => {
  it('the artist radio seed reads the artist through an index', () => {
    expect(plans.get('artistSeedTracks')).not.toContain('Seq Scan on tracks');
    expect(`artist seed: ${indexesIn('artistSeedTracks')}`).toContain('tracks_');
  });

  it('the album radio seed reaches the standalone album index', () => {
    expect(`album seed: ${indexesIn('albumSeedTracks')}`).toBe('album seed: tracks_album_id_idx');
  });

  it('the radio genre pool reads through the partial genre index', () => {
    expect(plans.get('radioGenrePool')).not.toContain('Seq Scan on tracks');
    expect(`genre pool: ${indexesIn('radioGenrePool')}`).toContain('tracks_genre_idx');
  });

  /**
   * The credited-on join is the query `track_credits.name_key` was indexed for.
   * Asserted on the credits side specifically: the tracks side can legitimately
   * be reached by primary key or by a partial index depending on selectivity,
   * but entering through `track_credits` rather than scanning it is the whole
   * point of the child table.
   */
  it('credited-on enters through the credits name key, not a scan', () => {
    expect(plans.get('creditedOn')).not.toContain('Seq Scan on track_credits');
    expect(`credited on: ${indexesIn('creditedOn')}`).toContain('track_credits_name_key_idx');
  });

  it('the fingerprint candidate bucket range-scans its duration index', () => {
    expect(`fingerprints: ${indexesIn('fingerprintBucket')}`).toContain(
      'track_fingerprints_duration_idx'
    );
  });

  it('the per-page rendition count does not scan the ladder table', () => {
    expect(plans.get('hlsCounts')).not.toContain('Seq Scan on track_hls_renditions');
  });
});
