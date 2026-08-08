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

/**
 * `beforeAll` seeds 40,000 tracks and their children, `ANALYZE`s, and runs an
 * `EXPLAIN (ANALYZE, BUFFERS)` per probe — all inside one transaction. That is
 * comfortably past bun's 5s default, and it got there gradually: the suite ran
 * at ~5.2s and failed intermittently with `a beforeEach/afterEach hook timed
 * out`, which names the wrong hook and says nothing about seeding, so the next
 * person would have spent the debugging on the wrong thing. Stated as an
 * explicit budget rather than left one probe away from flaking again.
 */
const SEED_AND_EXPLAIN_TIMEOUT_MS = 120_000;

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
    // `controllers/stream.controller.ts` — `findPlaybackTrack`, on every
    // resolve/key/master/variant request.
    name: 'playbackTrackById',
    sql: `select is_available, copyright_removed, status, hls_master_key from tracks
          where id = '${MARKER}-t-7' limit 1`,
  },
  {
    // `controllers/stream.controller.ts` — `findHlsRenditions`, and the same
    // read `preview.controller` falls back to.
    name: 'playbackRenditions',
    sql: `select manifest_key, bitrate_kbps, encrypted from track_hls_renditions
          where track_id = '${MARKER}-t-7' order by position asc`,
  },
  {
    // `controllers/stream.controller.ts` — `getStreamKey`. `track_id` is the
    // CATALOGUE arm since Task 13a, one of three parent columns each with its
    // own unique index — which is why the assertion below names the index
    // rather than the `track_keys_` prefix all three now share.
    name: 'playbackTrackKey',
    sql: `select key_hex from track_keys where track_id = '${MARKER}-t-7' limit 1`,
  },
  {
    // `controllers/preview.controller.ts` — the playable single-track read.
    // The playability predicate is composed FIRST, so this can reach a partial
    // index rather than only the primary key.
    name: 'previewTrack',
    sql: `select id, artist_id, album_id, title, duration, audio_source_url from tracks
          where is_available = true and copyright_removed = false and id = '${MARKER}-t-7'
          limit 1`,
  },
  {
    // `controllers/queue.controller.ts` — `resolvePlayableRefs`, the catalog half.
    name: 'queueRefs',
    sql: `select id, title from tracks
          where is_available = true and copyright_removed = false
            and id in ('${MARKER}-t-1','${MARKER}-t-2','${MARKER}-t-3')`,
  },
  {
    /**
     * `services/recommendations/recommendationService.ts` — the genre fallback
     * for related artists, with the projection this task WIDENED from five
     * columns to the public row. `select *` here is one column wider than
     * `publicColumns` (which drops `images` and `image_suggestions`); the point
     * is whether the planner still enters through an index rather than what the
     * exact column list costs.
     */
    name: 'relatedArtistsGenre',
    sql: `select * from catalog_entities
          where type = 'artist' and terminated is not true
            and id <> '${MARKER}-art-5' and genres && array['rock','pop']
          order by (image_id is not null) desc, popularity desc, stats_followers desc
          limit 20`,
  },
  {
    // Same file — the content fallback for similar tracks, same widening.
    name: 'similarTracksContent',
    sql: `select * from tracks
          where is_available = true and copyright_removed = false
            and id <> '${MARKER}-t-7' and (genre = 'rock' or artist_id = '${MARKER}-art-5')
          order by (cover_art_id is not null) desc, popularity desc, play_count desc
          limit 20`,
  },
  {
    // `controllers/artists.controller.ts` — `getArtistTracks`, the public page.
    name: 'artistTracksPage',
    sql: `select id, title from tracks
          where is_available = true and copyright_removed = false
            and artist_id = '${MARKER}-art-5'
          order by (cover_art_id is not null) desc, popularity desc, created_at desc
          limit 20 offset 0`,
  },
  {
    // Same handler — the total beside the page.
    name: 'artistTracksCount',
    sql: `select count(*) from tracks
          where is_available = true and copyright_removed = false
            and artist_id = '${MARKER}-art-5'`,
  },
  {
    // `controllers/artists.controller.ts` — `getArtistDashboard`'s recent list.
    // NOT playability-filtered: the artist's own view must show taken-down work.
    name: 'artistDashboardRecent',
    sql: `select id, title from tracks
          where artist_id = '${MARKER}-art-5' order by created_at desc limit 10`,
  },
  {
    // Same handler — the removed-for-copyright shelf, the complement predicate
    // that no partial index on this table can serve.
    name: 'artistDashboardRemoved',
    sql: `select id, title from tracks
          where artist_id = '${MARKER}-art-5' and copyright_removed = true
          order by removed_at desc limit 20`,
  },
  {
    // `controllers/artists.controller.ts` — `getArtistInsights`, which replaced
    // "load the whole catalogue into memory and sum it in JS".
    name: 'artistInsightsSum',
    sql: `select coalesce(sum(play_count), 0)::int from tracks
          where artist_id = '${MARKER}-art-5'`,
  },
  {
    // `controllers/artists.controller.ts` — `loadContributedTrackIds` step 1,
    // the artist's own track ids feeding the Mongo attestation lookup.
    name: 'contributedTrackIds',
    sql: `select id from tracks where artist_id = '${MARKER}-art-5'`,
  },
  {
    // `controllers/entityProfile.controller.ts` — `loadEntitySources`.
    name: 'entitySources',
    sql: `select provider, external_id from catalog_entity_sources
          where catalog_entity_id = '${MARKER}-art-5' order by position asc`,
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

  await executeRows(tx, sql.raw(`
    insert into catalog_entity_sources (id, catalog_entity_id, position, provider, external_id, imported_at, fields)
    select '${MARKER}-src-' || g, '${MARKER}-art-' || (1 + (g % 300)), g / 300, 'cc', 'ext-' || g,
           now(), array['bio']
    from generate_series(0, 899) g`));

  await executeRows(tx, sql.raw(`
    insert into track_keys (id, track_id, key_hex, key_uri)
    select '${MARKER}-k-' || g, '${MARKER}-t-' || g, repeat('ab', 16), 'key'
    from generate_series(1, 20000) g`));

  await executeRows(tx, sql.raw(
    'analyze image_assets, catalog_entities, albums, tracks, track_credits, track_fingerprints, ' +
    'track_hls_renditions, track_keys, catalog_entity_sources'
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
}, SEED_AND_EXPLAIN_TIMEOUT_MS);

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

describe('the playback read paths reach an index', () => {
  /**
   * These run on EVERY playback request — the resolve, the key fetch, the
   * master manifest and each variant — so a scan here is not a slow page, it is
   * a slow every-track-anyone-plays. Measured rather than assumed for the
   * reason the file's header gives: the previous instance of "surely a lookup
   * by id uses the index" was two artist-wide queries at 3,865 buffers.
   */
  it('the playback track read is a primary-key lookup', () => {
    expect(plans.get('playbackTrackById')).not.toContain('Seq Scan on tracks');
    expect(`playback track: ${indexesIn('playbackTrackById')}`).toBe('playback track: tracks_pkey');
  });

  it('the HLS ladder read enters through the ladder unique constraint', () => {
    expect(plans.get('playbackRenditions')).not.toContain('Seq Scan on track_hls_renditions');
    expect(`renditions: ${indexesIn('playbackRenditions')}`).toContain('track_hls_renditions_');
  });

  it('the content key read does not scan track_keys', () => {
    expect(plans.get('playbackTrackKey')).not.toContain('Seq Scan on track_keys');
    expect(`track key: ${indexesIn('playbackTrackKey')}`).toContain('track_keys_track_id_key');
  });

  it('the preview single-track read does not scan the table', () => {
    expect(plans.get('previewTrack')).not.toContain('Seq Scan on tracks');
  });

  it('the queue ref resolution does not scan the table', () => {
    expect(plans.get('queueRefs')).not.toContain('Seq Scan on tracks');
  });
});

describe('the artist surface reads reach an index', () => {
  /**
   * Every one of these is keyed on `artist_id`, and two of them deliberately
   * OMIT the playability predicate — the dashboard is the artist's own view and
   * has to show taken-down work. That is the exact shape migration `0017`'s
   * plain `tracks_artist_id_idx` exists for: the partial indexes cannot serve a
   * query whose predicate does not imply theirs, which is how the two
   * moderation queries were Seq Scans at 3,865 buffers before it.
   */
  it('the public artist track page reads through an index', () => {
    expect(plans.get('artistTracksPage')).not.toContain('Seq Scan on tracks');
    expect(`artist tracks: ${indexesIn('artistTracksPage')}`).toContain('tracks_');
  });

  it('its count does not scan the table', () => {
    expect(plans.get('artistTracksCount')).not.toContain('Seq Scan on tracks');
  });

  it('the dashboard recent list reaches the plain artist index', () => {
    expect(plans.get('artistDashboardRecent')).not.toContain('Seq Scan on tracks');
    expect(`dashboard recent: ${indexesIn('artistDashboardRecent')}`).toBe(
      'dashboard recent: tracks_artist_id_idx'
    );
  });

  it('the removed-for-copyright shelf reaches it too', () => {
    // `copyright_removed = true` is the complement of every partial index here.
    expect(plans.get('artistDashboardRemoved')).not.toContain('Seq Scan on tracks');
    expect(`dashboard removed: ${indexesIn('artistDashboardRemoved')}`).toBe(
      'dashboard removed: tracks_artist_id_idx'
    );
  });

  it('the insights sum aggregates through the index rather than scanning', () => {
    expect(plans.get('artistInsightsSum')).not.toContain('Seq Scan on tracks');
  });

  it('the contributed-ids read does not scan the table', () => {
    // Step 1 of the three that replaced the cross-database `$lookup`. It reads
    // the artist's whole catalogue, so an index here is what keeps the split
    // bounded rather than proportional to `tracks`.
    expect(plans.get('contributedTrackIds')).not.toContain('Seq Scan on tracks');
  });

  it('the entity provenance read does not scan its child table', () => {
    expect(plans.get('entitySources')).not.toContain('Seq Scan on catalog_entity_sources');
  });
});

describe('widening the recommendation projections did not cost an index', () => {
  /**
   * Task 10c replaced two hand-written five-column projections with
   * `publicColumns(...)`, because the narrow rows could not be serialized into
   * DTOs and four endpoints answered `{"id":""}`. A wider projection can flip an
   * Index Only Scan into an index scan plus a heap fetch, so this was A/B'd
   * against the exact narrow column lists it replaced rather than assumed
   * harmless — both twins EXPLAINed in the same transaction, on the same seed:
   *
   *   similarTracksContent   narrow 1,300 buffers / 5.9 ms   wide 1,300 / 9.9 ms
   *   relatedArtistsGenre    narrow    17 buffers / 0.23 ms   wide   366 / 0.30 ms
   *
   * Same index entries in both, in both queries. The tracks query costs no extra
   * I/O at all — the time is tuple deforming and a wider sort. The artists query
   * reads 349 more buffers, which is the heap fetch for rows it is about to
   * RETURN: unavoidable for any query that answers with those columns, and the
   * alternative measured 1,300 buffers cheaper while returning `{"id":""}`.
   *
   * The twins are not kept. They asserted nothing on their own, and a probe that
   * exists to have been run once is the kind of machinery that reads as
   * load-bearing to whoever touches this file next. What IS kept is the
   * property they establish: the planner enters through the SAME index, named,
   * so a regression says which index was lost rather than "no Seq Scan".
   */
  it('the related-artists genre fallback still enters through an index', () => {
    expect(plans.get('relatedArtistsGenre')).not.toContain('Seq Scan on catalog_entities');
    expect(`related artists: ${indexesIn('relatedArtistsGenre')}`).toBe(
      'related artists: catalog_entities_artist_name_key_key'
    );
  });

  it('the similar-tracks content fallback still enters through an index', () => {
    expect(plans.get('similarTracksContent')).not.toContain('Seq Scan on tracks');
    // Both arms of the `genre = … OR artist_id = …` are indexed; a plan that
    // lost either would fall back to scanning for that half.
    expect(`similar tracks: ${indexesIn('similarTracksContent')}`).toBe(
      'similar tracks: tracks_genre_idx, tracks_artist_id_album_id_idx'
    );
  });
});
