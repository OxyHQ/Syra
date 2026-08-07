/**
 * What the PLANNER does with the queries Task 13's creators vertical issues.
 *
 * Fourth of its family, after `db/catalog/__tests__/containers.explain.test.ts`,
 * `services.explain.test.ts` and `db/library/__tests__/library.explain.test.ts`,
 * and for the same reason: on this branch a definition assertion has certified a
 * query that turned out to be a Seq Scan four separate times. Reading the schema
 * does not answer whether Postgres can REACH an index for a given predicate.
 *
 * ## Seeding, rollback, and the control
 *
 * Everything runs inside ONE transaction that seeds real cardinality,
 * `ANALYZE`s, EXPLAINs and ROLLS BACK — the cleanup is the rollback rather than
 * a delete that could itself fail, and nothing is ever committed. On an empty
 * table the planner's choice is a coin flip and every assertion here would pass
 * for the wrong reason, which is what the seed floor below exists to refuse.
 *
 * `set local enable_seqscan = off` makes the planner prefer any index it CAN
 * use, so a remaining Seq Scan means no index could serve the query at all.
 * The control probe — a predicate no index covers — must still report one, or
 * "no Seq Scan" cannot be told from "stopped reading plans".
 *
 * ## What it found
 *
 * **The locker listing was sorting the whole locker on every page.** It shipped
 * with drizzle's `desc()`, and every descending index in this schema is
 * `DESC NULLS LAST` — see `db/catalog/containers.ts`'s `descNullsLast` for the
 * general form of the mismatch, which Task 10 found on the catalogue's own
 * listings. `created_at` is NOT NULL here, which makes the two spellings
 * semantically identical and reads like an exemption from that rule; it is not
 * one, because Postgres matches an ordering to an index syntactically and does
 * not reconcile the nulls placement using the constraint. `listUploadsNullsFirst`
 * below keeps the rejected shape and is asserted to STILL sort, which is what
 * makes the shipped form's measurement mean something.
 *
 * That is also why the assertions here check for the absence of a **Sort node**
 * rather than only naming the index: the index NAME is identical either way,
 * which is exactly what let the first version of this probe pass while the
 * query it described was sorting 4,300 rows to return 50.
 *
 * **Seed cardinality decides which index the planner picks.** Spread evenly
 * across 1,500 owners, the probed locker held 20 files, and at that size a
 * bitmap on the narrowest owner-leading index plus a sort beat everything —
 * so the probe measured a locker nobody has. One row in seven now goes to the
 * probed owner.
 *
 * **The sweeper's phase 1 uses the PARTIAL expiry index, and the third
 * predicate is a filter rather than a key.** `findUploadsDueForNotice` narrows
 * `expires_at` by range, and `deletion_notice_sent_at is null` is checked on
 * the heap rows the index returns. Adding it to the index would make the
 * partial index serve one phase and not the other; the range is what bounds
 * the work, and the batch cap bounds the rest.
 *
 * ## What these probes are worth, and what they are NOT
 *
 * They are TRANSCRIPTIONS of what `db/creators/*.ts` builds with drizzle, not
 * the shipped SQL, and **nothing binds the two** — this file imports nothing
 * from `db/creators/`. Each proves an index EXISTS AND IS REACHABLE for a
 * predicate of that shape; none proves the module still issues it. When one of
 * those queries changes its `WHERE`, change the probe with it, because no gate
 * will say so.
 *
 * **That limit is not theoretical, and an earlier revision of this comment
 * denied it.** It claimed the `listUploadsNullsFirst` probe meant the
 * `descNullsLast` fix "cannot be undone silently". Measured: reverting
 * `listOwnedUploads` to plain `desc()` leaves this suite at 25 pass / 0 fail,
 * and no other test in the tree notices either — `created_at` is `NOT NULL`, so
 * the ROWS are identical and only the plan differs. A paraphrase of a query
 * cannot gate the query.
 *
 * Binding the probes to the real builders (`.toSQL()` on what `db/creators/*.ts`
 * actually constructs) is the shape that would close it, and it is a change to
 * all four suites in this family rather than to this one — dispatched as its
 * own task. Until then, read every assertion here as being about an INDEX, never
 * about a call site.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb } from '../../postgres';

/** Thrown to roll the seeding transaction back once every plan is collected. */
class Rollback extends Error {}

/** Ids the seed writes, all carrying this prefix. Never committed. */
const MARKER = 'creators-explain';

const SEEDED_UPLOADS = 30000;
const SEEDED_OWNERS = 1500;
const SEEDED_TRACKS = 4000;
const SEEDED_CLAIMS = 6000;
const SEEDED_ATTESTATIONS = 4000;
const SEEDED_STANDINGS = 2000;

const SEED_AND_EXPLAIN_TIMEOUT_MS = 120_000;

/** Plan text by probe name, collected once in `beforeAll`. */
const plans = new Map<string, string>();

let seededUploadCount = 0;
let seededClaimCount = 0;

const PROBES: readonly { readonly name: string; readonly sql: string }[] = [
  {
    // `db/creators/uploads.ts` — `listOwnedUploads`, `GET /api/uploads`.
    name: 'listUploads',
    sql: `select id, title from user_uploads
          where owner_oxy_user_id = '${MARKER}-u-7' and deleted_at is null
          order by created_at desc nulls last limit 50 offset 0`,
  },
  {
    // `db/creators/uploads.ts` — `listLockerAlbums`, `GET /api/uploads/albums`.
    name: 'lockerAlbums',
    sql: `select album_key,
                 (array_agg(album_name order by disc_number nulls first, track_number nulls first))[1] as album_name,
                 count(*)::int as track_count
          from user_uploads
          where owner_oxy_user_id = '${MARKER}-u-7' and deleted_at is null
            and album_key is not null and album_key <> ''
          group by album_key`,
  },
  {
    // `db/creators/uploads.ts` — `findOwnedUpload`, every single-file read.
    name: 'ownedUpload',
    sql: `select id from user_uploads
          where id = '${MARKER}-up-7' and owner_oxy_user_id = '${MARKER}-u-7'
            and deleted_at is null limit 1`,
  },
  {
    // `db/creators/uploads.ts` — `findQueueableUploads`, the queue's locker half.
    name: 'queueableUploads',
    sql: `select id from user_uploads
          where id in ('${MARKER}-up-7', '${MARKER}-up-8', '${MARKER}-up-9')
            and owner_oxy_user_id = '${MARKER}-u-7'
            and deleted_at is null and status = 'ready'`,
  },
  {
    // `db/creators/uploads.ts` — `findUploadBySha256`, dedup tier 1's locker half.
    name: 'uploadByHash',
    sql: `select id from user_uploads
          where owner_oxy_user_id = '${MARKER}-u-7' and sha256 = '${MARKER}-sha-7'
            and deleted_at is null limit 1`,
  },
  {
    // `db/creators/uploads.ts` — `findUploadsMatchedToTrack`, the purge's first leg.
    name: 'purgeByMatchedTrack',
    sql: `select id, owner_oxy_user_id from user_uploads
          where matched_track_id = '${MARKER}-t-7'`,
  },
  {
    // `db/creators/uploads.ts` — `findUploadsBySha256`, the purge's second leg.
    name: 'purgeByHash',
    sql: `select id from user_uploads where sha256 in ('${MARKER}-sha-7', '${MARKER}-sha-8')`,
  },
  {
    // `db/creators/uploads.ts` — `findFingerprintCandidates`, the acoustic leg.
    name: 'purgeByFingerprintBucket',
    sql: `select id from user_uploads
          where fingerprint_duration_sec >= 207 and fingerprint_duration_sec <= 213`,
  },
  {
    // `db/creators/uploads.ts` — `findLockerStorageRefs`, the termination purge.
    // Deliberately WITHOUT the soft-delete filter: it has to reach the hidden
    // rows too, which is why the listing index above stays non-partial.
    name: 'wholeLockerPurge',
    sql: `select id from user_uploads where owner_oxy_user_id = '${MARKER}-u-7'`,
  },
  {
    // `db/creators/uploads.ts` — `findUploadsDueForNotice`, sweeper phase 1.
    name: 'sweepNotices',
    sql: `select id, owner_oxy_user_id, expires_at from user_uploads
          where deleted_at is null and deletion_notice_sent_at is null
            and expires_at > now() and expires_at <= now() + interval '14 days'
          order by expires_at asc limit 500`,
  },
  {
    // `db/creators/uploads.ts` — `findExpiredUploadIds`, sweeper phase 2.
    name: 'sweepSoftDeletes',
    sql: `select id from user_uploads
          where deleted_at is null and expires_at <= now() limit 500`,
  },
  {
    // `db/creators/uploads.ts` — `findUploadsPastGrace`, sweeper phase 3. The
    // one the Mongo collection had NO index for at all.
    name: 'sweepHardDeletes',
    sql: `select id from user_uploads
          where deleted_at <= now() - interval '30 days' limit 500`,
  },
  {
    // `db/creators/uploads.ts` — `loadUploadHls`, the ladder read.
    name: 'uploadHls',
    sql: `select manifest_key, bitrate_kbps from user_upload_hls_renditions
          where user_upload_id in ('${MARKER}-up-7', '${MARKER}-up-8')
          order by position asc`,
  },
  {
    // `db/creators/claims.ts` — `listArtistClaimsByClaimant`, "my claims".
    name: 'myClaims',
    sql: `select id from artist_claims
          where oxy_user_id = '${MARKER}-u-7' order by created_at desc nulls last limit 100`,
  },
  {
    // `db/creators/claims.ts` — `listArtistClaimsByStatus`, the review queue.
    name: 'claimQueue',
    sql: `select id from artist_claims
          where status = 'pending' order by created_at asc limit 50 offset 0`,
  },
  {
    // `db/creators/claims.ts` — `rejectOtherPendingClaims`'s target set, which
    // is the partial unique index's own leading column.
    name: 'otherPendingClaims',
    sql: `select id from artist_claims
          where artist_id = '${MARKER}-art-7' and status = 'pending'
            and id <> '${MARKER}-cl-7'`,
  },
  {
    // `db/creators/attestations.ts` — `findAttestationUploader`, per takedown.
    name: 'attestationByTrack',
    sql: `select uploader_oxy_user_id from contribution_attestations
          where track_id = '${MARKER}-t-7' limit 1`,
  },
  {
    // `db/creators/attestations.ts` — `findContributedTrackIds`, the
    // termination cascade's list of everything one account published.
    name: 'contributedTracks',
    sql: `select track_id from contribution_attestations
          where uploader_oxy_user_id = '${MARKER}-u-7'`,
  },
  {
    // `db/creators/attestations.ts` — `findAttestationsByTrackIds`, the
    // contribution panel.
    name: 'attestationsByTrackIds',
    sql: `select track_id, uploader_oxy_user_id from contribution_attestations
          where track_id in ('${MARKER}-t-7', '${MARKER}-t-8', '${MARKER}-t-9')`,
  },
  {
    // `db/creators/standings.ts` — `findContributorStanding`, on every public
    // upload through `canContributePublicly`.
    name: 'contributorStanding',
    sql: `select id, terminated, uploads_disabled from contributor_standings
          where oxy_user_id = '${MARKER}-u-7' limit 1`,
  },
  {
    // `db/creators/standings.ts` — `listContributorStrikes`.
    name: 'contributorStrikes',
    sql: `select reason, created_at from contributor_strikes
          where contributor_standing_id = '${MARKER}-st-7' order by created_at desc nulls last`,
  },
  {
    /**
     * The SHAPE THAT WAS REJECTED, kept as a probe so the finding cannot be
     * undone silently.
     *
     * `listOwnedUploads` was first written with drizzle's `desc()`, which emits
     * `DESC` (i.e. NULLS FIRST) while every descending index in this schema is
     * `DESC NULLS LAST`. Postgres matches an ordering to an index
     * syntactically, so the pathkeys never match and the plan becomes a bitmap
     * on the owner plus a quicksort of the WHOLE locker before the `LIMIT 50`.
     * `created_at` being NOT NULL makes the two semantically identical and
     * changes nothing about the plan. Asserted below to STILL sort, which is
     * what makes the shipped form's measurement mean something — but NOT what
     * would catch a revert, since this probe is a transcription and not the
     * shipped query. See the file header.
     */
    name: 'listUploadsNullsFirst',
    sql: `select id, title from user_uploads
          where owner_oxy_user_id = '${MARKER}-u-7' and deleted_at is null
          order by created_at desc limit 50 offset 0`,
  },
  {
    /**
     * The control. `user_uploads.codec` carries no index of any kind — the
     * locker has no `tsvector` either, deliberately (see `schema/creators.ts`)
     * — so this MUST still report a Seq Scan under `enable_seqscan = off`.
     */
    name: 'control',
    sql: `select id from user_uploads where codec = 'nothing-matches-this'`,
  },
];

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

async function seed(tx: Tx): Promise<void> {
  await executeRows(tx, sql.raw(`
    insert into catalog_entities (id, type, name, name_key, source, popularity)
    select '${MARKER}-art-' || g, 'artist', '${MARKER} artist ' || g, '${MARKER}-artist' || g, 'upload', g % 101
    from generate_series(1, 400) g`));

  await executeRows(tx, sql.raw(`
    insert into tracks (id, title, artist_id, artist_name, duration, source, status, popularity)
    select '${MARKER}-t-' || g, 'Track ' || g, '${MARKER}-art-' || (1 + (g % 400)), 'Artist',
           150 + (g % 120), 'upload', 'ready', g % 101
    from generate_series(1, ${SEEDED_TRACKS}) g`));

  /**
   * The locker, with every dimension the probes narrow on actually varying.
   *
   * One row in 17 is soft-deleted, one in 7 carries no album key at all, one in
   * 5 has already been noticed, and `expires_at` is spread across a year. A
   * seed where every row looked the same could not tell a partial index that
   * serves the sweep from one that cannot — which is the whole question here,
   * since `user_uploads_expires_at_idx` is `WHERE deleted_at is null`.
   *
   * `sha256` is `g` itself, one distinct hash per row. A modulus was tried and
   * collides on `user_uploads_owner_oxy_user_id_sha256_key` once the probed
   * owner takes one row in seven: two different generator families then land on
   * the same owner, and their hash cycles overlap. The constraint is per OWNER,
   * so distinct-per-row is the only spelling that cannot collide however the
   * owners are distributed — the same trap `library.explain.test.ts` recorded on
   * its own junctions, met from the other direction.
   *
   * ONE IN SEVEN ROWS GOES TO THE PROBED OWNER, and that is not decoration.
   * Spread evenly across 1,500 owners the probed locker held 20 files, and at
   * that size the planner rationally chose a bitmap on the owner prefix plus a
   * quicksort over `listUploads`' ORDER BY — the ordered index never won, so
   * the probe measured a locker nobody has rather than the one the index exists
   * for. At ~4,300 files it is the real question again.
   */
  await executeRows(tx, sql.raw(`
    insert into user_uploads (id, owner_oxy_user_id, title, album_key, album_name,
                              disc_number, track_number, duration, size_bytes, sha256,
                              fingerprint_duration_sec, status, matched_track_id,
                              expires_at, deletion_notice_sent_at, deleted_at, created_at)
    select '${MARKER}-up-' || g,
           case when g % 7 = 0 then '${MARKER}-u-7'
                else '${MARKER}-u-' || (1 + (g % ${SEEDED_OWNERS})) end,
           'File ' || g,
           case when g % 7 = 0 then null else '${MARKER}-alb-' || (1 + (g % 400)) end,
           case when g % 7 = 0 then null else 'Album ' || (1 + (g % 400)) end,
           1 + (g % 2), 1 + (g % 12),
           150 + (g % 120), 5000000,
           '${MARKER}-sha-' || g,
           200 + (g % 40),
           case when g % 13 = 0 then 'processing' else 'ready' end,
           case when g % 9 = 0 then '${MARKER}-t-' || (1 + (g % ${SEEDED_TRACKS})) else null end,
           now() + ((g % 365) || ' days')::interval,
           case when g % 5 = 0 then now() - interval '1 day' else null end,
           case when g % 17 = 0 then now() - ((g % 90) || ' days')::interval else null end,
           now() - (g || ' seconds')::interval
    from generate_series(1, ${SEEDED_UPLOADS}) g`));

  await executeRows(tx, sql.raw(`
    insert into user_upload_hls_renditions (id, user_upload_id, position, manifest_key, bitrate_kbps, encrypted)
    select '${MARKER}-hls-' || g, '${MARKER}-up-' || (1 + (g % ${SEEDED_UPLOADS})), 0,
           'hls/' || g || '/index.m3u8', 160, true
    from generate_series(1, ${SEEDED_UPLOADS}) g`));

  /**
   * Claims, one in three still pending.
   *
   * The pair `(artist, claimant)` steps by two coprime moduli so the PARTIAL
   * unique index (`WHERE status = 'pending'`) is not violated by two pending
   * rows for the same pair — which is precisely the constraint
   * `otherPendingClaims` reads through.
   */
  await executeRows(tx, sql.raw(`
    insert into artist_claims (id, artist_id, oxy_user_id, evidence, status, created_at)
    select '${MARKER}-cl-' || g,
           '${MARKER}-art-' || (1 + (g % 400)),
           '${MARKER}-u-' || (1 + ((g * 3) % 1499)),
           'evidence ' || g,
           case when g % 3 = 0 then 'pending' when g % 3 = 1 then 'approved' else 'rejected' end,
           now() - (g || ' seconds')::interval
    from generate_series(1, ${SEEDED_CLAIMS}) g`));

  // One attestation per contributed track — `contribution_attestations_track_id_key`
  // is unique, so the generator walks the track ids directly.
  await executeRows(tx, sql.raw(`
    insert into contribution_attestations (id, track_id, uploader_oxy_user_id, statement, accepted_at)
    select '${MARKER}-at-' || g, '${MARKER}-t-' || g,
           '${MARKER}-u-' || (1 + (g % ${SEEDED_OWNERS})),
           'I may distribute this recording', now()
    from generate_series(1, ${SEEDED_ATTESTATIONS}) g`));

  await executeRows(tx, sql.raw(`
    insert into contributor_standings (id, oxy_user_id, strike_count)
    select '${MARKER}-st-' || g, '${MARKER}-u-' || g, g % 3
    from generate_series(1, ${SEEDED_STANDINGS}) g`));

  await executeRows(tx, sql.raw(`
    insert into contributor_strikes (id, contributor_standing_id, reason, created_at)
    select '${MARKER}-sk-' || g, '${MARKER}-st-' || (1 + (g % ${SEEDED_STANDINGS})),
           'notice ' || g, now() - (g || ' seconds')::interval
    from generate_series(1, 6000) g`));

  await executeRows(tx, sql.raw(
    'analyze catalog_entities, tracks, user_uploads, user_upload_hls_renditions, ' +
    'artist_claims, contribution_attestations, contributor_standings, contributor_strikes'
  ));

  const [uploads] = await executeRows<{ total: number }>(
    tx, sql.raw(`select count(*)::int as total from user_uploads where id like '${MARKER}-%'`));
  seededUploadCount = uploads?.total ?? 0;

  const [claims] = await executeRows<{ total: number }>(
    tx, sql.raw(`select count(*)::int as total from artist_claims where id like '${MARKER}-%'`));
  seededClaimCount = claims?.total ?? 0;
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

/** Assert one probe reached an index at all, naming the table it must not scan. */
function expectIndexed(probe: string, table: string): void {
  expect(`${probe}: ${plans.get(probe)?.includes(`Seq Scan on ${table}`) ?? 'NO PLAN'}`).toBe(
    `${probe}: false`
  );
}

/**
 * Every index that leads with the given SQL column, by name.
 *
 * Used where the planner has a free choice among several: `user_uploads` has
 * four indexes leading with `owner_oxy_user_id`, and for a predicate that
 * constrains ONLY that column any of them is a correct answer — Postgres picks
 * the narrowest. Asserting one name would be asserting a costing decision that
 * moves with the statistics; asserting the leading column is the property the
 * schema actually promises.
 */
const OWNER_LEADING_UPLOAD_INDEXES = [
  'user_uploads_owner_oxy_user_id_created_at_idx',
  'user_uploads_owner_oxy_user_id_status_idx',
  'user_uploads_owner_oxy_user_id_album_key_idx',
  'user_uploads_owner_oxy_user_id_sha256_key',
];

function expectOwnerLeadingIndex(probe: string): void {
  const used = indexesIn(probe).split(', ').filter(Boolean);
  const offenders = used.filter((name) => !OWNER_LEADING_UPLOAD_INDEXES.includes(name));
  expect(`${probe} used non-owner-leading: ${offenders.join(', ') || 'none'}`).toBe(
    `${probe} used non-owner-leading: none`
  );
  // Vacuity floor: an empty list would satisfy the filter above trivially.
  expect(`${probe} used any index: ${used.length > 0}`).toBe(`${probe} used any index: true`);
}

/**
 * Assert the ORDERING came from the index, not from a sort on top of it.
 *
 * Separate from {@link expectIndexed} because the two failures look identical
 * in the index name: a `DESC NULLS FIRST` ordering against a `DESC NULLS LAST`
 * index still uses that index as a predicate scan and then sorts everything it
 * returned. Only the plan SHAPE tells them apart.
 */
function expectNoSort(probe: string): void {
  expect(`${probe} sorts: ${plans.get(probe)?.includes('Sort Key:') ?? 'NO PLAN'}`).toBe(
    `${probe} sorts: false`
  );
}

describe('the seed is real', () => {
  it('inserted the rows the plans were measured against', () => {
    // Not decoration: on a seed that inserted nothing, every plan below is a
    // measurement of an empty table and every "no Seq Scan" assertion passes
    // for the wrong reason.
    expect(seededUploadCount).toBe(SEEDED_UPLOADS);
    expect(seededClaimCount).toBe(SEEDED_CLAIMS);
  });

  it('the control still reports a table scan under enable_seqscan = off', () => {
    expect(plans.get('control')).toContain('Seq Scan on user_uploads');
  });

  it('collected a plan for every probe', () => {
    // A probe whose EXPLAIN silently returned nothing would make its own
    // assertions compare `undefined` against a substring and pass.
    expect(PROBES.filter((probe) => !plans.get(probe.name)).map((probe) => probe.name)).toEqual([]);
  });
});

describe('the locker reads reach an index', () => {
  it('the listing walks the owner+created_at index in order, with no sort', () => {
    expectIndexed('listUploads', 'user_uploads');
    expectNoSort('listUploads');
    expect(`listing: ${indexesIn('listUploads')}`).toBe(
      'listing: user_uploads_owner_oxy_user_id_created_at_idx'
    );
  });

  it('the rejected NULLS FIRST spelling still sorts the whole locker', () => {
    // The control for the finding above: same index available, same rows, and
    // the plan degrades to a sort purely on the nulls placement.
    expect(`rejected sorts: ${plans.get('listUploadsNullsFirst')?.includes('Sort Key:')}`).toBe(
      'rejected sorts: true'
    );
  });

  /**
   * The album page reaches its index for the GROUPING and still sorts.
   *
   * `(owner_oxy_user_id, album_key, disc_number, track_number)` supplies the
   * rows in group order; the outer `ORDER BY` is over three aggregate
   * expressions, which no index can supply. Asserted as it is rather than
   * wished away — the Mongo pipeline sorted there too.
   */
  it('the album page groups through an owner-leading index', () => {
    // The GROUP BY is over `album_key`, but the only constrained column is the
    // owner — so the planner is free among the four owner-leading indexes and
    // measured here it takes the narrowest (`..._status_idx`). What the schema
    // promises is that the owner prefix is reachable, which is what this asserts.
    expectIndexed('lockerAlbums', 'user_uploads');
    expectOwnerLeadingIndex('lockerAlbums');
  });

  it('a single owned file is a primary-key point lookup', () => {
    expectIndexed('ownedUpload', 'user_uploads');
    expect(`owned: ${indexesIn('ownedUpload')}`).toBe('owned: user_uploads_pkey');
  });

  it('the queue resolves its locker refs by id, not by scanning the owner', () => {
    expectIndexed('queueableUploads', 'user_uploads');
    expect(`queue: ${indexesIn('queueableUploads')}`).toBe('queue: user_uploads_pkey');
  });

  it("dedup tier 1 reaches the owner's own copy through a hash index", () => {
    /**
     * Either hash index is a correct answer and the planner takes
     * `user_uploads_sha256_idx`, because a content hash is more selective than
     * an owner: it resolves to one row and re-checks the owner on the heap.
     * The composite `(owner, sha256)` unique constraint is what makes the WRITE
     * safe; this read only needs SOME index on the hash.
     */
    expectIndexed('uploadByHash', 'user_uploads');
    const used = indexesIn('uploadByHash');
    expect(`dedup used a hash index: ${used.includes('sha256')}`).toBe(
      'dedup used a hash index: true'
    );
  });

  it('the HLS ladder is read through its own unique constraint', () => {
    expectIndexed('uploadHls', 'user_upload_hls_renditions');
    expect(`hls: ${indexesIn('uploadHls')}`).toBe(
      'hls: user_upload_hls_renditions_user_upload_id_position_key'
    );
  });
});

describe("compliance's three purge legs reach an index", () => {
  /**
   * All three, because a purge that falls back to a scan on the one table this
   * design expects to reach millions of rows is a takedown that times out —
   * and two of these three indexes did not exist in Mongo at all.
   */
  it('the matched-track leg uses the index Mongo did not have', () => {
    expectIndexed('purgeByMatchedTrack', 'user_uploads');
    expect(`matched: ${indexesIn('purgeByMatchedTrack')}`).toBe(
      'matched: user_uploads_matched_track_id_idx'
    );
  });

  it('the hash leg uses the standalone sha256 index, not the per-owner unique', () => {
    // The unique constraint leads with `owner_oxy_user_id`, so it cannot serve
    // a hash-only lookup — which is exactly why `schema/creators.ts` declares
    // this second index.
    expectIndexed('purgeByHash', 'user_uploads');
    expect(`hash: ${indexesIn('purgeByHash')}`).toBe('hash: user_uploads_sha256_idx');
  });

  it('the acoustic leg narrows by the fingerprint duration bucket', () => {
    expectIndexed('purgeByFingerprintBucket', 'user_uploads');
    expect(`acoustic: ${indexesIn('purgeByFingerprintBucket')}`).toBe(
      'acoustic: user_uploads_fingerprint_duration_sec_idx'
    );
  });

  /**
   * The whole-locker purge must see SOFT-DELETED rows, which is the reason
   * `schema/creators.ts` keeps the listing index NON-partial. A partial index
   * here would silently stop serving the one query that has to find them.
   */
  it('the termination purge reaches every row of one locker, hidden ones included', () => {
    // Owner-only predicate, so the planner is free among the four owner-leading
    // indexes — the point is that NONE of them is partial on `deleted_at`, so
    // whichever it picks still returns the soft-deleted rows this purge exists
    // to reach.
    expectIndexed('wholeLockerPurge', 'user_uploads');
    expectOwnerLeadingIndex('wholeLockerPurge');
  });
});

describe("the expiry sweeper's three phases reach an index", () => {
  it('phase 1 narrows the notice window through the partial expiry index', () => {
    expectIndexed('sweepNotices', 'user_uploads');
    expect(`notices: ${indexesIn('sweepNotices')}`).toBe(
      'notices: user_uploads_expires_at_idx'
    );
  });

  it('phase 2 uses the same partial index for the expired set', () => {
    expectIndexed('sweepSoftDeletes', 'user_uploads');
    expect(`soft deletes: ${indexesIn('sweepSoftDeletes')}`).toBe(
      'soft deletes: user_uploads_expires_at_idx'
    );
  });

  /**
   * Phase 3 had NO Mongo index at all, on a job that runs unattended every hour
   * over the largest table in the schema. This is the probe that says the added
   * one is reachable rather than merely declared.
   */
  it('phase 3 reaches the deleted_at index Mongo lacked entirely', () => {
    expectIndexed('sweepHardDeletes', 'user_uploads');
    expect(`hard deletes: ${indexesIn('sweepHardDeletes')}`).toBe(
      'hard deletes: user_uploads_deleted_at_idx'
    );
  });
});

describe('the moderation records reach an index', () => {
  it("a claimant's own claims come from the oxy_user_id index", () => {
    /**
     * No `expectNoSort` here, unlike the locker listing, and the difference is
     * real rather than an omission: a claimant has a handful of claims, so the
     * planner bitmaps the four rows and sorts them — cheaper than an ordered
     * walk, and bounded by `limit 100` however many they have. The ordering
     * spelling is still `descNullsLast`, so the ordered path is AVAILABLE if
     * one claimant ever accumulates enough for it to win.
     */
    expectIndexed('myClaims', 'artist_claims');
    expect(`my claims: ${indexesIn('myClaims')}`).toBe(
      'my claims: artist_claims_oxy_user_id_created_at_idx'
    );
  });

  it('the review queue comes from the status index, oldest first', () => {
    expectIndexed('claimQueue', 'artist_claims');
    // ASCENDING needs no `nullsLast` spelling: Postgres's `ASC` default IS
    // NULLS LAST, which is what drizzle's plain `.on(column)` declares.
    expectNoSort('claimQueue');
    expect(`queue: ${indexesIn('claimQueue')}`).toBe(
      'queue: artist_claims_status_created_at_idx'
    );
  });

  it('closing the other open claims on a granted artist reaches the partial unique index', () => {
    expectIndexed('otherPendingClaims', 'artist_claims');
    expect(`other claims: ${indexesIn('otherPendingClaims')}`).toBe(
      'other claims: artist_claims_artist_id_oxy_user_id_pending_key'
    );
  });

  it('an attestation is found by its track through the unique constraint', () => {
    expectIndexed('attestationByTrack', 'contribution_attestations');
    expect(`by track: ${indexesIn('attestationByTrack')}`).toBe(
      'by track: contribution_attestations_track_id_key'
    );
  });

  it("the termination cascade reads one account's contributions from an index", () => {
    expectIndexed('contributedTracks', 'contribution_attestations');
    expect(`contributed: ${indexesIn('contributedTracks')}`).toBe(
      'contributed: contribution_attestations_uploader_oxy_user_id_idx'
    );
  });

  it('the contribution panel resolves a page of track ids through the unique constraint', () => {
    expectIndexed('attestationsByTrackIds', 'contribution_attestations');
    expect(`panel: ${indexesIn('attestationsByTrackIds')}`).toBe(
      'panel: contribution_attestations_track_id_key'
    );
  });

  it('a contributor standing is a point lookup on every public upload', () => {
    expectIndexed('contributorStanding', 'contributor_standings');
    expect(`standing: ${indexesIn('contributorStanding')}`).toBe(
      'standing: contributor_standings_oxy_user_id_key'
    );
  });

  it("a contributor's strikes come from the child index", () => {
    // Same bounded-set reasoning as `myClaims`: an account terminates at three
    // strikes, so the sort is over a handful of rows.
    expectIndexed('contributorStrikes', 'contributor_strikes');
    expect(`strikes: ${indexesIn('contributorStrikes')}`).toBe(
      'strikes: contributor_strikes_contributor_standing_id_idx'
    );
  });
});
