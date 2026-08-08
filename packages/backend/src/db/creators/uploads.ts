/**
 * `user_uploads` and its two child tables — the private locker's row access.
 *
 * Six modules read or write these rows (`uploads.controller`, `queue
 * .controller`, `matchCatalog`, `expirySweeper`, `ingestUserUpload`,
 * `takedown`), which is why the projections live here rather than being spelled
 * out six times: `user_uploads` carries six PROTECTED columns, and six
 * independently-written `select`s are six chances to name one.
 *
 * ## `publicColumns` is the default read, and the exceptions are named
 *
 * {@link UPLOAD_COLUMNS} is `publicColumns(userUploads, …)`, so `sha256`,
 * `fingerprint` and the four `rawTags*` columns are absent from
 * {@link UploadRow} at the TYPE level — a serializer that reaches for one fails
 * `tsc` rather than shipping it. Two paths legitimately need a protected
 * column and say so by naming it (`sha256` for dedup, `fingerprint` for the
 * acoustic purge); those live in {@link findUploadBySha256} and
 * {@link findFingerprintCandidates}, and nothing else in the codebase selects
 * either.
 *
 * ## The HLS ladder is a second read, always
 *
 * `UserUpload.hls[]` was an embedded array and is `user_upload_hls_renditions`
 * now. Only four call sites need it — the stream resolver, the two manifest
 * endpoints and the manual delete — plus {@link withHls} for the purge's
 * storage refs, so it is never folded into the row read. The locker LISTING,
 * which is the hot path, would otherwise pay for a join it never looks at.
 */

import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  notInArray,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import { descNullsLast } from '../catalog/containers';
import type { HlsRendition, ProvenanceMarker } from '@syra/shared-types';
import { getDb, type DbOrTransaction } from '../postgres';
import { PROTECTED_COLUMNS_BY_TABLE } from '../schema/protectedColumns';
import {
  userUploadHlsRenditions,
  userUploadProvenanceMarkers,
  userUploads,
} from '../schema/creators';

/**
 * Every column of `user_uploads` a client-facing path may see.
 *
 * `PROTECTED_COLUMNS_BY_TABLE` is passed straight through, never through an
 * intermediate typed as `ProtectedColumnRegistry` — see that registry's own
 * doc comment for what widening it costs (the runtime filter stays correct; the
 * compile-time guarantee collapses).
 */
export const UPLOAD_COLUMNS = publicColumns(userUploads, PROTECTED_COLUMNS_BY_TABLE);

/**
 * A `user_uploads` row as {@link UPLOAD_COLUMNS} returns it.
 *
 * Derived from the REGISTRY, the same way `db/catalog/serialize.ts` derives
 * `PublicTrackRow` — a hand-written omit list here would be a second copy of
 * the registry that could disagree with the one `publicColumns` actually reads.
 */
export type UploadRow = Omit<
  typeof userUploads.$inferSelect,
  (typeof PROTECTED_COLUMNS_BY_TABLE)['user_uploads'][number]
>;

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * A live (not soft-deleted) locker file that belongs to this owner.
 *
 * Owner is part of the QUERY, never a comparison after the fact: a wrong owner
 * produces "not found", which is also the right answer for privacy — a stranger
 * must not be able to tell a locker id apart from a nonexistent one.
 *
 * `deleted_at is null` is the single spelling of "not soft-deleted". Mongo's
 * readers used two (`deletedAt: null` and `deletedAt: { $exists: false }`),
 * which are NOT the same predicate there and agreed only because nothing ever
 * stored an explicit null; in Postgres the divergence is not representable.
 */
export async function findOwnedUpload(
  uploadId: string,
  ownerOxyUserId: string
): Promise<UploadRow | undefined> {
  const [upload] = await getDb()
    .select(UPLOAD_COLUMNS)
    .from(userUploads)
    .where(
      and(
        eq(userUploads.id, uploadId),
        eq(userUploads.ownerOxyUserId, ownerOxyUserId),
        isNull(userUploads.deletedAt)
      )
    )
    .limit(1);

  return upload;
}

/** The same file WITHOUT the soft-delete filter — the manual delete path's read. */
export async function findOwnedUploadIncludingDeleted(
  uploadId: string,
  ownerOxyUserId: string
): Promise<UploadRow | undefined> {
  const [upload] = await getDb()
    .select(UPLOAD_COLUMNS)
    .from(userUploads)
    .where(and(eq(userUploads.id, uploadId), eq(userUploads.ownerOxyUserId, ownerOxyUserId)))
    .limit(1);

  return upload;
}

/**
 * One owner's locker, newest first, plus the total.
 *
 * `descNullsLast` — `db/catalog/containers.ts`'s helper, not drizzle's `desc()`
 * — and the difference is a whole-locker sort on every page. That module's own
 * doc comment has the general measurement (~250x on the catalogue's own
 * listing); this vertical reproduced it: `user_uploads_owner_oxy_user_id_
 * created_at_idx` is declared `created_at DESC NULLS LAST`, plain `desc()` asks
 * for `DESC` (i.e. NULLS FIRST), and Postgres matches an ordering to an index
 * syntactically. On 4,300 files for one owner, `desc()` gave a Bitmap Heap Scan
 * plus a quicksort of the entire locker BEFORE the `LIMIT 50`; `descNullsLast`
 * gives an Index Scan that stops after 50 rows.
 *
 * The trap is that `created_at` is `NOT NULL`, so the two are semantically
 * identical and the migration's shorthand rule — "use `descNullsLast` unless
 * the column is NOT NULL" — reads like an exemption. It is an exemption about
 * CORRECTNESS only; the planner still cannot match the pathkey.
 * `__tests__/creators.explain.test.ts` therefore asserts the absence of the
 * Sort NODE, not merely the index name, because the index name is identical
 * either way.
 */
export async function listOwnedUploads(
  ownerOxyUserId: string,
  limit: number,
  offset: number
): Promise<{ uploads: UploadRow[]; total: number }> {
  const live = and(eq(userUploads.ownerOxyUserId, ownerOxyUserId), isNull(userUploads.deletedAt));

  const [uploads, [counted]] = await Promise.all([
    getDb()
      .select(UPLOAD_COLUMNS)
      .from(userUploads)
      .where(live)
      .orderBy(descNullsLast(userUploads.createdAt))
      .limit(limit)
      .offset(offset),
    getDb().select({ total: sql<number>`count(*)::int` }).from(userUploads).where(live),
  ]);

  return { uploads, total: counted?.total ?? 0 };
}

/** One owner's locker, grouped into releases by `album_key`. */
export interface LockerAlbum {
  albumKey: string;
  albumName: string | null;
  albumArtistName: string | null;
  year: number | null;
  coverArtId: string | null;
  trackCount: number;
  totalDuration: number;
  trackIds: string[];
}

/**
 * The locker's album page.
 *
 * There is no per-user `albums` table and there must not be one — a private
 * file may not create a catalog container — so a release is an aggregation over
 * the computed `album_key`, exactly as the Mongo `$group` was.
 *
 * The four `$first`-after-`$sort` fields become ordered aggregates — see
 * {@link first} — and deliberately NOT `min()`. The ordering they aggregate in
 * is the same `(disc_number, track_number)` the Mongo `$sort` used, which is
 * also the tail of the `(owner_oxy_user_id, album_key, disc_number,
 * track_number)` index this query reads.
 */
export async function listLockerAlbums(ownerOxyUserId: string): Promise<LockerAlbum[]> {
  /**
   * `$first` after `$sort: { albumKey, discNumber, trackNumber }`.
   *
   * `min()` would be the obvious aggregate and is a different answer: `$first`
   * means "the value carried by the lowest-numbered track", so a release whose
   * opener has no cover but whose track 7 does must report no cover, not track
   * 7's. `(array_agg(x order by …))[1]` is that, exactly.
   *
   * `nulls first` on both ordinals because Mongo's ascending sort puts a
   * missing field BEFORE a present one and Postgres's puts it after — the same
   * inversion `desc()`/`descNullsLast` has, in the other direction. An untagged
   * track number is the lowest-numbered track here, as it was there.
   */
  const first = (column: SQLWrapper): SQL =>
    sql`(array_agg(${column} order by ${userUploads.discNumber} nulls first, ${userUploads.trackNumber} nulls first))[1]`;

  return getDb()
    .select({
      albumKey: sql<string>`${userUploads.albumKey}`,
      albumName: sql<string | null>`${first(userUploads.albumName)}`,
      albumArtistName: sql<string | null>`${first(userUploads.albumArtistName)}`,
      year: sql<number | null>`${first(userUploads.year)}`,
      coverArtId: sql<string | null>`${first(userUploads.coverArtId)}`,
      trackCount: sql<number>`count(*)::int`,
      totalDuration: sql<number>`coalesce(sum(${userUploads.duration}), 0)::double precision`,
      trackIds: sql<
        string[]
      >`array_agg(${userUploads.id} order by ${userUploads.discNumber} nulls first, ${userUploads.trackNumber} nulls first)`,
    })
    .from(userUploads)
    .where(
      and(
        eq(userUploads.ownerOxyUserId, ownerOxyUserId),
        isNull(userUploads.deletedAt),
        // A file with no album tags has no release to belong to; grouping the
        // untagged ones would invent an album called nothing. `<> ''` as well
        // as `is not null` because `buildAlbumKey` answers a non-empty `"||"`
        // for a file with no tags at all, and the Mongo filter excluded both.
        sql`${userUploads.albumKey} is not null and ${userUploads.albumKey} <> ''`
      )
    )
    .groupBy(userUploads.albumKey)
    // Same `nulls first` reasoning as the window ordering above: Mongo's
    // ascending `$sort` on the three display fields put an absent value first.
    .orderBy(
      sql`${first(userUploads.albumArtistName)} asc nulls first`,
      sql`${first(userUploads.year)} asc nulls first`,
      sql`${first(userUploads.albumName)} asc nulls first`
    );
}

/**
 * The queue's locker half: this owner's files, by id, that can actually play.
 *
 * `status = 'ready'` is the locker's equivalent of `playableTrackFilter` — a
 * file still being transcoded has no HLS ladder, so queueing it would queue
 * silence. Owner is in the same query, so somebody else's locker item is not
 * addressable at all: it resolves to nothing, exactly as a nonexistent id does.
 *
 * The empty-list guard is load-bearing in a way the Mongo `$in` did not need:
 * `inArray(column, [])` generates `in ()`, which is a Postgres syntax error
 * rather than an empty result.
 */
export async function findQueueableUploads(
  uploadIds: readonly string[],
  ownerOxyUserId: string
): Promise<UploadRow[]> {
  if (uploadIds.length === 0) return [];

  return getDb()
    .select(UPLOAD_COLUMNS)
    .from(userUploads)
    .where(
      and(
        inArray(userUploads.id, [...uploadIds]),
        eq(userUploads.ownerOxyUserId, ownerOxyUserId),
        isNull(userUploads.deletedAt),
        eq(userUploads.status, 'ready')
      )
    );
}

/**
 * The row the PROMOTE path needs, which is the public row plus two protected
 * columns.
 *
 * Named rather than reached for through a whole-row read, and the two are named
 * for different reasons. `sha256` re-runs the dedup chain against the catalogue
 * as it stands today — the recording may have been published by its actual
 * artist since this file was stored, and contributing it now would create a
 * second copy. `fingerprint` is reused so promotion costs no extra decode; it is
 * the same acoustic identification the direct upload performs, and skipping it
 * would make "file it privately, then promote" the way around the block.
 *
 * Neither value leaves this call: the controller hands them to `matchCatalog`
 * and to `identifyForPublication` and serialises neither.
 */
export async function findOwnedUploadForPromotion(
  uploadId: string,
  ownerOxyUserId: string
): Promise<(UploadRow & { sha256: string; fingerprint: number[] }) | undefined> {
  const [upload] = await getDb()
    .select({ ...UPLOAD_COLUMNS, sha256: userUploads.sha256, fingerprint: userUploads.fingerprint })
    .from(userUploads)
    .where(
      and(
        eq(userUploads.id, uploadId),
        eq(userUploads.ownerOxyUserId, ownerOxyUserId),
        isNull(userUploads.deletedAt)
      )
    )
    .limit(1);

  return upload;
}

/**
 * The uploader's own LIVE copy of these exact bytes — dedup tier 1's locker half.
 *
 * Soft-deleted rows are excluded, and that is right for a MATCH: answering
 * `{ kind: 'upload' }` for a file the owner can no longer play or see would
 * point them at nothing.
 *
 * It is NOT right for recovering from the unique constraint — see
 * {@link findUploadHoldingHashSlot}, which is the same two columns and a
 * different predicate on purpose.
 *
 * `sha256` is a PROTECTED column, and this names it deliberately: matching ON a
 * protected value is not exposing it, and the function returns an id rather
 * than the hash. The row read is otherwise the narrowest in this module.
 */
export async function findUploadBySha256(
  ownerOxyUserId: string,
  sha256: string
): Promise<{ id: string } | undefined> {
  const [existing] = await getDb()
    .select({ id: userUploads.id })
    .from(userUploads)
    .where(
      and(
        eq(userUploads.ownerOxyUserId, ownerOxyUserId),
        eq(userUploads.sha256, sha256),
        isNull(userUploads.deletedAt)
      )
    )
    .limit(1);

  return existing;
}

/**
 * Whichever row HOLDS the `(owner_oxy_user_id, sha256)` unique slot — the one a
 * `23505` on that constraint just collided with.
 *
 * Soft-deleted rows included, and the predicate must match the CONSTRAINT
 * rather than match {@link findUploadBySha256}. `user_uploads_owner_oxy_user_id
 * _sha256_key` is not partial on `deleted_at`, so a soft-deleted row keeps
 * occupying the slot for the whole 30-day grace window the sweeper leaves
 * between hiding a file and deleting it. A lookup that filtered `deleted_at`
 * would find nothing after a collision that definitely happened, and
 * `storeLockerUpload` would rethrow a constraint violation as a 500.
 *
 * That is not hypothetical and it is not test-only: it was live for every
 * re-upload of bytes whose earlier copy was inside its grace window — a
 * reproducible 500 where the answer is `{ outcome: 'duplicate' }`. Reusing
 * `findUploadBySha256` here is what caused it, because the two questions read
 * identically and are not the same question.
 */
export async function findUploadHoldingHashSlot(
  ownerOxyUserId: string,
  sha256: string
): Promise<{ id: string } | undefined> {
  const [existing] = await getDb()
    .select({ id: userUploads.id })
    .from(userUploads)
    .where(and(eq(userUploads.ownerOxyUserId, ownerOxyUserId), eq(userUploads.sha256, sha256)))
    .limit(1);

  return existing;
}

// ── Storage refs (the delete paths) ─────────────────────────────────────────

/**
 * Where one locker file's bytes are, and who loses it.
 *
 * The three storage fields plus the two the purge reports on — never
 * `fingerprint`. These rows are loaded only to be deleted, and a locker
 * fingerprint is thousands of int32s per row; the sweeper walks up to 500 of
 * them per tick, so pulling that across the wire to read three key fields would
 * be the whole batch's cost.
 */
export interface UploadStorageRef {
  id: string;
  ownerOxyUserId: string;
  audioSourceKey: string | null;
  hlsMasterKey: string | null;
  hls: HlsRendition[];
}

const STORAGE_REF_COLUMNS = {
  id: userUploads.id,
  ownerOxyUserId: userUploads.ownerOxyUserId,
  audioSourceKey: userUploads.audioSourceKey,
  hlsMasterKey: userUploads.hlsMasterKey,
} as const;

type StorageRefRow = { [K in keyof typeof STORAGE_REF_COLUMNS]: UploadRow[K] };

/** Attach each row's manifest keys — one grouped read for the whole batch. */
async function withHls(rows: readonly StorageRefRow[]): Promise<UploadStorageRef[]> {
  const byUpload = await loadUploadHls(rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, hls: byUpload.get(row.id) ?? [] }));
}

/** Storage refs for a named set of uploads. */
export async function findUploadStorageRefs(uploadIds: readonly string[]): Promise<UploadStorageRef[]> {
  if (uploadIds.length === 0) return [];
  const rows = await getDb()
    .select(STORAGE_REF_COLUMNS)
    .from(userUploads)
    .where(inArray(userUploads.id, [...uploadIds]));
  return withHls(rows);
}

/** Storage refs for every file in one owner's locker, soft-deleted rows included. */
export async function findLockerStorageRefs(ownerOxyUserId: string): Promise<UploadStorageRef[]> {
  const rows = await getDb()
    .select(STORAGE_REF_COLUMNS)
    .from(userUploads)
    .where(eq(userUploads.ownerOxyUserId, ownerOxyUserId));
  return withHls(rows);
}

/** Storage refs for the locker copies linked to one catalog track. */
export async function findUploadsMatchedToTrack(trackId: string): Promise<
  (UploadStorageRef & { sha256: string })[]
> {
  const rows = await getDb()
    .select({ ...STORAGE_REF_COLUMNS, sha256: userUploads.sha256 })
    .from(userUploads)
    .where(eq(userUploads.matchedTrackId, trackId));

  const withRenditions = await withHls(rows);
  return withRenditions.map((ref, index) => ({ ...ref, sha256: rows[index].sha256 }));
}

/** Storage refs for every locker copy of these exact bytes, excluding ids already doomed. */
export async function findUploadsBySha256(
  shas: readonly string[],
  excludeIds: readonly string[]
): Promise<UploadStorageRef[]> {
  if (shas.length === 0) return [];

  const rows = await getDb()
    .select(STORAGE_REF_COLUMNS)
    .from(userUploads)
    .where(
      excludeIds.length > 0
        ? and(
            inArray(userUploads.sha256, [...shas]),
            notInArray(userUploads.id, [...excludeIds])
          )
        : inArray(userUploads.sha256, [...shas])
    );
  return withHls(rows);
}

/**
 * The acoustic purge's candidate bucket: locker files whose duration is close
 * enough to be the same recording, with their fingerprints.
 *
 * `fingerprint` is protected and named here for the same reason `sha256` is in
 * {@link findUploadBySha256}: comparing audio is the one job that needs it, and
 * the values never leave `takedown.ts`.
 */
export async function findFingerprintCandidates(
  minDurationSec: number,
  maxDurationSec: number,
  excludeIds: readonly string[]
): Promise<(UploadStorageRef & { fingerprint: number[] })[]> {
  const rows = await getDb()
    .select({ ...STORAGE_REF_COLUMNS, fingerprint: userUploads.fingerprint })
    .from(userUploads)
    .where(
      and(
        gte(userUploads.fingerprintDurationSec, minDurationSec),
        lte(userUploads.fingerprintDurationSec, maxDurationSec),
        excludeIds.length > 0 ? notInArray(userUploads.id, [...excludeIds]) : undefined
      )
    );

  const withRenditions = await withHls(rows);
  return withRenditions.map((ref, index) => ({ ...ref, fingerprint: rows[index].fingerprint }));
}

// ── The expiry sweeper's three phases ────────────────────────────────────────

/** Phase 1: files entering the notice window that have not been warned about. */
export async function findUploadsDueForNotice(
  now: Date,
  noticeHorizon: Date,
  limit: number
): Promise<{ id: string; ownerOxyUserId: string; expiresAt: Date | null }[]> {
  return getDb()
    .select({
      id: userUploads.id,
      ownerOxyUserId: userUploads.ownerOxyUserId,
      expiresAt: userUploads.expiresAt,
    })
    .from(userUploads)
    .where(
      and(
        isNull(userUploads.deletedAt),
        isNull(userUploads.deletionNoticeSentAt),
        gt(userUploads.expiresAt, now),
        lte(userUploads.expiresAt, noticeHorizon)
      )
    )
    // `asc`, and `expires_at` is NULLABLE — but every row here has already been
    // narrowed to a range, so a null cannot reach the sort. Spelled `asc` for
    // the same reason the Mongo sort was `1`: soonest first is what decides
    // which files a capped batch warns about.
    .orderBy(asc(userUploads.expiresAt))
    .limit(limit);
}

/** Phase 2: live files past their expiry. */
export async function findExpiredUploadIds(now: Date, limit: number): Promise<string[]> {
  const rows = await getDb()
    .select({ id: userUploads.id })
    .from(userUploads)
    .where(and(isNull(userUploads.deletedAt), lte(userUploads.expiresAt, now)))
    .limit(limit);

  return rows.map((row) => row.id);
}

/** Phase 3: soft-deleted files past the grace window, with their storage refs. */
export async function findUploadsPastGrace(
  graceCutoff: Date,
  limit: number
): Promise<UploadStorageRef[]> {
  const rows = await getDb()
    .select(STORAGE_REF_COLUMNS)
    .from(userUploads)
    .where(lte(userUploads.deletedAt, graceCutoff))
    .limit(limit);
  return withHls(rows);
}

/** Stamp a batch of uploads as warned. Returns how many rows moved. */
export async function markDeletionNoticeSent(uploadIds: readonly string[], now: Date): Promise<number> {
  if (uploadIds.length === 0) return 0;
  const updated = await getDb()
    .update(userUploads)
    .set({ deletionNoticeSentAt: now })
    .where(inArray(userUploads.id, [...uploadIds]))
    .returning({ id: userUploads.id });
  return updated.length;
}

/** Soft-delete a batch of uploads. Returns how many rows moved. */
export async function softDeleteUploads(uploadIds: readonly string[], now: Date): Promise<number> {
  if (uploadIds.length === 0) return 0;
  const updated = await getDb()
    .update(userUploads)
    .set({ deletedAt: now })
    .where(inArray(userUploads.id, [...uploadIds]))
    .returning({ id: userUploads.id });
  return updated.length;
}

/**
 * Delete locker rows for good.
 *
 * Their `user_upload_hls_renditions` and `user_upload_provenance_markers` rows
 * go with them, by real `ON DELETE cascade` foreign keys rather than by two
 * deletes every caller has to remember.
 *
 * Their `track_keys` row goes too, since Task 13a — `track_keys.user_upload_id`
 * is a third such cascade (`schema/trackKeys.ts`). It used to be the exception:
 * one polymorphic `track_id` across three id spaces could carry no foreign key,
 * so each caller deleted the key itself, `deleteUpload` did and `expirySweeper`
 * did not, and every file the sweeper removed left an AES key behind forever.
 * Neither caller has an explicit delete now, which is the point — the next one
 * will not need to remember it either.
 */
export async function deleteUploads(uploadIds: readonly string[]): Promise<number> {
  if (uploadIds.length === 0) return 0;
  const deleted = await getDb()
    .delete(userUploads)
    .where(inArray(userUploads.id, [...uploadIds]))
    .returning({ id: userUploads.id });
  return deleted.length;
}

// ── Child tables ─────────────────────────────────────────────────────────────

/** Each upload's HLS ladder, in ladder order. One query for the whole batch. */
export async function loadUploadHls(
  uploadIds: readonly string[]
): Promise<Map<string, HlsRendition[]>> {
  if (uploadIds.length === 0) return new Map();

  const rows = await getDb()
    .select({
      userUploadId: userUploadHlsRenditions.userUploadId,
      manifestKey: userUploadHlsRenditions.manifestKey,
      bitrateKbps: userUploadHlsRenditions.bitrateKbps,
      encrypted: userUploadHlsRenditions.encrypted,
    })
    .from(userUploadHlsRenditions)
    .where(inArray(userUploadHlsRenditions.userUploadId, [...uploadIds]))
    .orderBy(asc(userUploadHlsRenditions.position));

  const byUpload = new Map<string, HlsRendition[]>();
  for (const row of rows) {
    const ladder = byUpload.get(row.userUploadId);
    const rendition = {
      manifestKey: row.manifestKey,
      bitrateKbps: row.bitrateKbps,
      encrypted: row.encrypted,
    };
    if (ladder) ladder.push(rendition);
    else byUpload.set(row.userUploadId, [rendition]);
  }
  return byUpload;
}

/**
 * Replace one upload's HLS ladder with exactly these renditions.
 *
 * Replace, never append: ingest can re-run on the same file, and a second pass
 * that appended would leave the manifest builder choosing between two copies of
 * every rung. `position` carries the array index, assigned from the input order
 * here so there is one place that decides what "the second rendition" means.
 */
export async function setUploadHls(
  db: DbOrTransaction,
  uploadId: string,
  hls: readonly HlsRendition[]
): Promise<void> {
  await db
    .delete(userUploadHlsRenditions)
    .where(eq(userUploadHlsRenditions.userUploadId, uploadId));

  if (hls.length === 0) return;

  await db.insert(userUploadHlsRenditions).values(
    hls.map((rendition, position) => ({
      userUploadId: uploadId,
      position,
      manifestKey: rendition.manifestKey,
      bitrateKbps: rendition.bitrateKbps,
      encrypted: rendition.encrypted,
    }))
  );
}

/** Replace one upload's provenance markers with exactly these, in order. */
export async function setUploadProvenanceMarkers(
  db: DbOrTransaction,
  uploadId: string,
  markers: readonly ProvenanceMarker[]
): Promise<void> {
  await db
    .delete(userUploadProvenanceMarkers)
    .where(eq(userUploadProvenanceMarkers.userUploadId, uploadId));

  if (markers.length === 0) return;

  await db.insert(userUploadProvenanceMarkers).values(
    markers.map((marker, position) => ({
      userUploadId: uploadId,
      position,
      code: marker.code,
      weight: marker.weight,
      detail: marker.detail,
    }))
  );
}
