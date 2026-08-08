/**
 * Creators and uploads schema — the private locker (`user_uploads`), the
 * public contribution path's evidence chain (`contribution_attestations`),
 * and the three moderation records that hang off them (`artist_claims`,
 * `contributor_standings`/`contributor_strikes`, `copyright_reports`).
 *
 * Ported from `packages/backend/src/models/{UserUpload,ArtistClaim,
 * ContributionAttestation,ContributorStanding,CopyrightReport}.ts`, field by
 * field, against `packages/backend/docs/db/RELATIONS.md` for every foreign
 * key.
 *
 * **Those five model files no longer exist.** Task 13 ported the vertical and
 * deleted them (`CopyrightReport` went earlier, with Task 10c-3). Every
 * `models/…` citation below — including the line and enum numbers — is
 * PROVENANCE, naming what this schema was derived from, and is resolvable in
 * git rather than in the tree. Read them that way; none is a live pointer.
 *
 * ## The deferred ledger is EMPTY after this task
 *
 * `tracks.copyrightReportId` (`catalog.ts`, Task 2) was the last entry
 * `deferredForeignKeys.ts` held. `copyright_reports` lands here, so that
 * column becomes a real `.references(() => copyrightReports.id, { onDelete:
 * 'set null' })` in `catalog.ts` and the entry is DELETED, not edited — see
 * that file's own comment on the column and `__tests__/gates.test.ts`'s
 * "closes the last deferred foreign key, leaving the ledger EMPTY".
 *
 * That reference makes `catalog.ts` and this file MUTUALLY importing, which
 * is fine and deliberate: `.references()` takes a thunk that drizzle does not
 * call until it builds a table's config, long after both modules have
 * finished evaluating. Verified end to end rather than assumed — `db:generate`
 * emits the constraint and the migrated database carries it.
 *
 * The property that makes the cycle SAFE, rather than merely working, is that
 * NEITHER module reads a value from the other at module-evaluation time — see
 * {@link UPLOAD_STATUSES}. Every cross-module reference in both directions is
 * inside a callback drizzle invokes lazily, so which module a process loads
 * first cannot matter. Keep it that way: an eager read added here or there
 * (`text({ enum: SOMETHING_FROM_CATALOG })` is one) reintroduces a
 * `Cannot access '...' before initialization` that only fires for one of the
 * two load orders.
 *
 * ## `UserUpload` is a separate table from `tracks`, and that is the point
 *
 * `playableTrackFilter()` has no owner dimension and is declared invariant, so
 * a private file written as a `Track` would be searchable, browsable and
 * recommendable the moment it saved. Keeping the two apart is what makes that
 * leak impossible by construction rather than by remembering an owner check at
 * every catalog read — see `models/UserUpload.ts`'s own doc comment. Nothing
 * in this file is reachable from a catalog read.
 *
 * ## Which subdocument arrays became child tables, and which did not
 *
 * This file inherited two rules from `catalog.ts` that, read literally,
 * disagree with each other on the same shape:
 *
 *  - `track_credits` is a child table because `Track.credits[]` is queried by
 *    element; `DiscogsRelease.credits[]` and `CatalogEntity.members[]` are the
 *    IDENTICAL `TrackCredit`/`ArtistMember` shape and stayed `jsonb` because
 *    nothing queries them by element.
 *  - `track_hls_renditions`/`episode_hls_renditions` are child tables even
 *    though NEITHER `hls` array is queried by element, on the grounds that an
 *    array of objects with a known, shared shape becomes a child table
 *    "independent of query-by-element evidence".
 *
 * Applied naively, the second rule makes the first one's jsonb columns wrong,
 * and vice versa. The discriminator that actually reconciles the schema as
 * landed — and the one this file uses — is **whether live code writes the
 * array at all**:
 *
 *  - ~~`DiscogsRelease.credits[]` / `CatalogEntity.members[]` / `CatalogEntity
 *    .imageSuggestions[]`: no writer anywhere.~~ **FALSE — see below. Do not
 *    read this bullet as an assertion; it is kept only so the correction has
 *    something to point at.**
 *  - `Track.hls[]` / `Episode.hls[]` / every `sources[]`: written by live
 *    code. Child tables.
 *
 * ## The second bullet is false, and Task 10b measured it
 *
 * All three have writers:
 *
 *  - `CatalogEntity.members[]` — `services/uploads/enrichCatalogEntity.ts`
 *    (`gapFilling`, from Wikidata's `has part`), reachable in production from
 *    `ensureContributedArtist` → `enqueueArtistEnrichment`.
 *  - `CatalogEntity.imageSuggestions[]` — the same file's
 *    `suggestArtistPhotosFromUpload`, called by `uploads.controller`, and read
 *    back by `artists.controller.ts:1086` (`.select('+imageSuggestions')`).
 *  - `DiscogsRelease.credits[]` — `scripts/importDiscogsReleases.ts:201`
 *    parses and writes them. That one is a manually-run script with no npm
 *    script or caller wiring it, which is the weakest of the three, but it is
 *    not "no writer".
 *
 * The claim came from `catalog.ts`'s `catalogEntityId` paragraph, which is
 * correct about the `catalogEntityId` SUB-FIELD and was widened here into a
 * claim about the arrays that carry it.
 *
 * The consequence is left OPEN rather than acted on, because it is a schema
 * decision and Task 10b is a services port: **the discriminator this section
 * states — "whether live code writes the array at all" — does not, on the
 * corrected facts, produce the schema as landed.** Applied honestly it would
 * make `members` and `imageSuggestions` child tables. Either the discriminator
 * needs restating (query-by-element, which DOES produce the schema as landed
 * and is what `catalog.ts` actually argues), or two columns are wrong. Do not
 * cite this paragraph as settled reasoning until that is decided.
 *
 * **RULED (Task 10b review):** they SHOULD be child tables — the same reasoning
 * that made `episode_hls_renditions` and then `track_hls_renditions` child
 * tables, both of which also failed the queried-by-element test and passed the
 * known-shape one. It lands as a dedicated schema task rather than inside a
 * services port, so `members` and `imageSuggestions` stay `jsonb` for now as a
 * known cost rather than a hidden one.
 *
 * So, in this file:
 *
 *  - `UserUpload.hls[]` -> `user_upload_hls_renditions`. Written by
 *    `services/ingest/ingestUserUpload.ts:129`, and the third instance of
 *    `HlsRenditionSchema` in this schema — identical shape, identical
 *    treatment.
 *  - `UserUpload.provenance.markers[]` -> `user_upload_provenance_markers`,
 *    and `ContributionAttestation.provenanceReport.markers[]` ->
 *    `contribution_attestation_provenance_markers`. Same
 *    `ProvenanceMarkerSchema` declared on both models, both written by live
 *    code (`storeLockerUpload`'s `provenance: report`,
 *    `publishContribution`'s `provenanceReport: params.report`), so both get
 *    the same treatment — the divergence rule 4 of this migration exists to
 *    prevent.
 *  - `UserUpload.credits[]` -> `jsonb`, matching `DiscogsRelease.credits[]`
 *    exactly. NOT written anywhere: `extractMetadata` builds a `credits`
 *    array in memory, but `storeLockerUpload` (`controllers/uploads
 *    .controller.ts:746`) never assigns it to the document and
 *    `updateUserUploadRequestSchema` cannot set it. Grepped for every write
 *    site of the model; there is none.
 *  - `UserUpload.lyrics` -> `jsonb`, same reason. Its `lines[]` would be the
 *    fourth `LyricsLine` child table (`lyrics_lines` is the third) if anything
 *    ever wrote it; nothing does, on either half — no writer AND no reader
 *    outside the model file.
 *
 * `provenance` and `provenanceReport` are themselves single subdocuments, so
 * their two scalar fields are FLATTENED onto the parent row
 * (`provenance_score`/`provenance_verdict`), the same treatment
 * `tracks.audioSource`/`metadata`/`replayGain` and `episodes.cache` already
 * get. Only the array inside them becomes a table.
 *
 * ## Dead fields ported anyway, and named
 *
 * Beyond `credits` and `lyrics` above, `UserUpload` declares nine release-
 * edition fields (`totalTracks`, `totalDiscs`, `originalReleaseDate`,
 * `catalogNumber`, `label`, `media`, `releaseCountry`, `replayGain`,
 * `comment`) and `coverArtSizes` that no code path ever writes —
 * `extractMetadata` produces every one of them and `storeLockerUpload` keeps
 * none. `coverArtSizes` is worse than unused: `toUploadTrackDto` READS it, so
 * it is another shipped read half of a mechanism whose write half was never
 * connected. They are ported as columns (the intent is real, the read site
 * depends on one of them, and `tracks` carries the identical set) but the
 * migration should not expect any non-null values to carry over. Counted in
 * this task's report rather than absorbed silently.
 *
 * ## Server-only columns
 *
 * `select: false` is a QUERY PROJECTION and `aggregate()` ignores it, so it
 * was never the guard on this data. The guards here are
 * `PROTECTED_COLUMNS_BY_TABLE` (`protectedColumns.ts`) plus the hand-written
 * DTO allowlist `toUploadTrackDto`. Registered there: this table's flattened
 * `rawTags*` columns (Mongoose `select: false` on both models), `fingerprint`
 * ("thousands of integers... exposing it would hand a client the acoustic
 * index it would need to enumerate the catalog"), `sha256` (the same audio
 * content hash `tracks.sha256` is protected for), and the attestation's `ip`
 * and `userAgent` — request context about a person, held as legal evidence,
 * which no client has ever been served and none should be.
 *
 * The storage keys (`audio_source_key`, `hls_master_key`, and
 * `user_upload_hls_renditions.manifest_key`) are deliberately NOT in that
 * registry, even though `toUploadTrackDto`'s own doc comment calls itself the
 * boundary that keeps every storage key behind it. `catalog.ts` does not
 * protect the identical columns on `tracks`/`track_hls_renditions`, and one
 * vertical protecting what its twin does not is exactly the silent divergence
 * this schema keeps getting bitten by. The DTO allowlist is the guard for
 * both; if that judgement is wrong it is wrong for `tracks` too, and should
 * be fixed in one change across both verticals rather than half-applied here.
 *
 * ## No expiry-sweep entry, deliberately
 *
 * `UserUpload.expiresAt` looks exactly like the TTL columns `expiry.ts`
 * exists for, and it must NOT be registered there. Mongo's TTL index was
 * declined on this collection for a reason the model spells out: a blind row
 * delete leaves every one of the file's S3 objects orphaned and skips the
 * T-14d warning the retention policy promises. `sweepExpiredRows` is exactly
 * that blind delete. `services/uploads/expirySweeper.ts` is the sweeper —
 * notice, then soft-delete, then objects-before-document — and it stays the
 * one that owns this column.
 *
 * ## No `tsvector`
 *
 * Every browsable table in this schema carries one. The locker is not
 * browsable: `listUploads` filters by owner and sorts by `createdAt`, the
 * album view groups by `album_key`, and there is no search endpoint over
 * uploads at all. A GIN index nothing can query is cost with no reader.
 *
 * ## `deletedAt: null` vs `deletedAt: { $exists: false }`
 *
 * The Mongo readers use both spellings for "not soft-deleted"
 * (`controllers/uploads.controller.ts:680` vs `services/uploads/
 * matchCatalog.ts:169`), which are NOT the same predicate in Mongo — an
 * explicitly-stored `null` matches the first and not the second. They agree
 * today only because nothing ever stores an explicit null. In Postgres both
 * are `deleted_at is null`, so the divergence disappears at the port rather
 * than being carried forward.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import type { TrackCredit, UploadLyrics } from '@syra/shared-types';
import { catalogEntities, imageAssets, tracks } from './catalog';

// ── Closed value sets ────────────────────────────────────────────────────
// Same convention as catalog.ts: one `as const` tuple per closed value set,
// used both to type the column and to derive its CHECK.

/** `@syra/shared-types` `provenanceMarkerWeightSchema`. */
export const PROVENANCE_MARKER_WEIGHTS = ['low', 'medium', 'high', 'blocking'] as const;

/** `@syra/shared-types` `provenanceVerdictSchema`. */
export const PROVENANCE_VERDICTS = ['clean', 'suspect', 'commercial'] as const;

/**
 * `@syra/shared-types` `artistClaimStatusSchema`. There is no
 * "auto-approved" value and there never will be — a contributed profile is
 * built from a stranger's file tags, so every claim is reviewed by a human.
 */
export const ARTIST_CLAIM_STATUSES = ['pending', 'approved', 'rejected'] as const;

/**
 * The DMCA review workflow's own `status` enum — carried over from
 * `models/CopyrightReport.ts`, which Task 10c-3 deleted once
 * `copyright.controller` moved to drizzle and nothing imported the model.
 *
 * Deliberately a SECOND tuple with the same three values as
 * `ARTIST_CLAIM_STATUSES` rather than a shared one: they are two independent
 * review workflows (a claim on an identity, a DMCA notice against a work), and
 * merging them would make a value added to one silently legal in the other.
 */
export const COPYRIGHT_REPORT_STATUSES = ['pending', 'approved', 'rejected'] as const;

/**
 * `models/UserUpload.ts`'s own `status` enum, and `UploadAudioSourceSchema`'s
 * own `format` enum — declared HERE rather than imported from `catalog.ts`,
 * for exactly the reason `COPYRIGHT_REPORT_STATUSES` above is its own tuple.
 *
 * These carry the same values as `tracks`' `TRACK_STATUSES`/`AUDIO_FORMATS`
 * today, and the first pass of this file shared those. That was inconsistent
 * with the rule the file itself states one paragraph up: `UserUpload`
 * declares its OWN Mongoose enums (`models/UserUpload.ts:93,215`), so a value
 * added to the catalog's ingest states would have become silently legal for a
 * locker file too. The coupling that does exist — a locker file becomes a
 * `Track` at promote time — is a MAPPING, and if it needs enforcing it needs
 * a test asserting the mapping, not a shared tuple that hides whether anyone
 * ever checked.
 *
 * It also removes the cycle hazard the first pass had to work around:
 * `catalog.ts` imports this module back (for `tracks.copyrightReportId`), and
 * reading a value from it at module-EVALUATION time — which
 * `text({ enum: AUDIO_FORMATS })` in a columns object is — threw
 * `Cannot access 'AUDIO_FORMATS' before initialization` whenever `catalog.ts`
 * was reached first. With no eager read left in either direction, every
 * remaining cross-module reference is inside a callback drizzle invokes
 * lazily, and the load order stops mattering at all.
 */
export const UPLOAD_STATUSES = ['processing', 'ready', 'failed'] as const;

/** See {@link UPLOAD_STATUSES} — `models/UserUpload.ts:93`'s own format enum. */
export const UPLOAD_AUDIO_FORMATS = ['mp3', 'flac', 'ogg', 'm4a', 'wav'] as const;

/** `models/ArtistClaim.ts`'s `maxlength` on `evidence`. */
const CLAIM_EVIDENCE_MAX_LENGTH = 4000;

/** `models/ArtistClaim.ts`'s `maxlength` on `resolutionNote`. */
const CLAIM_RESOLUTION_NOTE_MAX_LENGTH = 2000;

// ── user_uploads ─────────────────────────────────────────────────────────

export const userUploads = pgTable(
  'user_uploads',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    ownerOxyUserId: text().notNull(),

    title: text().notNull(),
    /**
     * Optional on purpose: a file with no artist tag is a valid PRIVATE
     * upload. The public contribution path is where an artist is mandatory,
     * because without attribution there is no claimable profile and no
     * addressee for a takedown.
     */
    artistName: text(),
    /** `albumartist` — differs from `artistName` on compilations and features. */
    albumArtistName: text(),
    albumName: text(),
    /**
     * `buildAlbumKey(albumArtistName, albumName, year)`. The locker has no
     * `albums` row by design — a private file must not create a catalog
     * container — so the locker's album page is an aggregation over this
     * column, which makes its index the album page rather than an
     * optimisation of it.
     */
    albumKey: text(),
    trackNumber: integer(),
    discNumber: integer(),
    year: integer(),
    /** Mongoose gives every upload an implicit `[]`; matched here, as `tracks.tags` is. */
    genres: text().array().notNull().default(sql`array[]::text[]`),
    /**
     * `UploadLyrics` — jsonb, and dead. Nothing writes it and nothing reads
     * it outside the model file; see the file-level doc comment for why a
     * dead array does not earn the `lyrics_lines` child-table treatment its
     * shape would otherwise get.
     */
    lyrics: jsonb().$type<UploadLyrics>(),

    // ── Edition facts captured from the file's tags (same set as `tracks`) ──
    // Every one of these is extracted and then never persisted; see the
    // file-level doc comment. Ported because `tracks` carries the identical
    // set and the intent is real.
    totalTracks: integer(),
    totalDiscs: integer(),
    originalReleaseDate: text(),
    catalogNumber: text(),
    label: text(),
    media: text(),
    releaseCountry: text(),
    replayGainTrackDb: doublePrecision(),
    replayGainAlbumDb: doublePrecision(),
    replayGainTrackPeak: doublePrecision(),
    comment: text(),
    /** `TrackCredit[]` — jsonb, and dead. See the file-level doc comment. */
    credits: jsonb().$type<TrackCredit[]>(),

    /** Seconds, fractional, from ffprobe — same treatment as `tracks.duration`. */
    duration: doublePrecision().notNull(),
    codec: text(),
    bitrateKbps: integer(),
    /** Bounded by `MAX_AUDIO_UPLOAD_BYTES` (200 MiB), so `integer` cannot overflow. */
    sizeBytes: integer().notNull(),

    /** Server-only — see `PROTECTED_COLUMNS_BY_TABLE`. */
    sha256: text().notNull(),
    /**
     * Chromaprint raw int32 values — server-only, and the reason
     * `expirySweeper`'s phase-3 query projects three fields rather than
     * loading the row: thousands of integers per file.
     */
    fingerprint: integer().array().notNull().default(sql`array[]::integer[]`),
    fingerprintDurationSec: doublePrecision(),

    coverArtId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    // Never written (see the file-level doc comment), but READ by
    // `toUploadTrackDto` — the columns are the shape that read expects.
    coverArtSizesSmallId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesMediumId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesLargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesXlargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesXxlargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesOriginalId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    primaryColor: text(),
    secondaryColor: text(),

    /**
     * `UploadAudioSource`, flattened — a bare S3 key, never a URL: locker
     * audio is served only through `GET /api/uploads/:id/stream` after an
     * ownership check, so there is no playable address to hand out.
     */
    audioSourceKey: text(),
    audioSourceFormat: text({ enum: UPLOAD_AUDIO_FORMATS }),
    // The HLS rendition LADDER is `user_upload_hls_renditions`, below.
    hlsMasterKey: text(),
    loudnessLufs: doublePrecision(),

    status: text({ enum: UPLOAD_STATUSES }).notNull().default('processing'),

    /**
     * Set at promote time. The locker copy is deliberately KEPT and pointed
     * at the new track, so SET NULL — losing the catalog track must not take
     * the owner's own file with it.
     */
    matchedTrackId: text().references(() => tracks.id, { onDelete: 'set null' }),
    /** Set alongside `matchedTrackId`, and only on a HIGH-confidence artist resolution. */
    resolvedArtistId: text().references(() => catalogEntities.id, { onDelete: 'set null' }),

    lastPlayedAt: timestamptz(),
    playCount: integer().notNull().default(0),
    /** `max(lastPlayedAt, createdAt) + 365d`, pushed forward on every play. */
    expiresAt: timestamptz(),
    deletionNoticeSentAt: timestamptz(),
    deletedAt: timestamptz(),

    /** `ProvenanceReport`, flattened; its `markers[]` is a child table below. */
    provenanceScore: doublePrecision(),
    provenanceVerdict: text({ enum: PROVENANCE_VERDICTS }),

    /**
     * `RawTags`, flattened — the file's native tag block, server-only. Stored
     * as a JSON STRING rather than a nested object because tag keys are
     * arbitrary user-supplied text; a string is inert. See
     * `PROTECTED_COLUMNS_BY_TABLE`.
     */
    rawTagsFormat: text(),
    rawTagsJson: text(),
    rawTagsTruncated: boolean(),
    rawTagsOriginalByteLength: integer(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('user_uploads_status_check', sql`${t.status} in (${sql.raw(inList(UPLOAD_STATUSES))})`),
    check(
      'user_uploads_audio_source_format_check',
      sql`${t.audioSourceFormat} is null or ${t.audioSourceFormat} in (${sql.raw(inList(UPLOAD_AUDIO_FORMATS))})`
    ),
    check(
      'user_uploads_provenance_verdict_check',
      sql`${t.provenanceVerdict} is null or ${t.provenanceVerdict} in (${sql.raw(inList(PROVENANCE_VERDICTS))})`
    ),
    check('user_uploads_play_count_check', sql`${t.playCount} >= 0`),
    check('user_uploads_size_bytes_check', sql`${t.sizeBytes} >= 0`),
    /**
     * One copy of the same bytes per owner — a CONSTRAINT, not a check in
     * the handler: two concurrent uploads of the same file are the ordinary
     * case (a double tap, a retried request) and a read-then-write leaves
     * exactly the window the second one lands in. The unique violation IS
     * the duplicate detector; `storeLockerUpload` answers it with
     * `{ outcome: 'duplicate' }` rather than treating it as an error.
     */
    unique('user_uploads_owner_oxy_user_id_sha256_key').on(t.ownerOxyUserId, t.sha256),
    /**
     * The locker listing (`listUploads`, newest first).
     *
     * NON-partial deliberately, unlike the sweep indexes below: this same
     * leading column serves compliance's whole-locker purge
     * (`takedown.ts:509`, `find({ ownerOxyUserId })`), which must see
     * soft-deleted rows too. A `WHERE deleted_at is null` partial index
     * would silently stop serving the one query that has to find them.
     */
    index('user_uploads_owner_oxy_user_id_created_at_idx').on(t.ownerOxyUserId, t.createdAt.desc()),
    /** "Which of my uploads are still processing / failed" — ingest polling. */
    index('user_uploads_owner_oxy_user_id_status_idx').on(t.ownerOxyUserId, t.status),
    /**
     * The locker's album page: one owner's files, in album then disc/track
     * order (`getLockerAlbums`' `$sort` before `$group`).
     */
    index('user_uploads_owner_oxy_user_id_album_key_idx').on(
      t.ownerOxyUserId,
      t.albumKey,
      t.discNumber,
      t.trackNumber
    ),
    /**
     * The takedown purge's second leg (`takedown.ts:369`, `sha256: { $in }`),
     * which the per-owner unique constraint above cannot serve — it leads
     * with `owner_oxy_user_id`.
     */
    index('user_uploads_sha256_idx').on(t.sha256),
    /**
     * The takedown purge's candidate bucket: a DMCA takedown has to reach
     * every locker copy INCLUDING re-encodes, which hash differently, so
     * that leg narrows by duration and then compares fingerprints.
     */
    index('user_uploads_fingerprint_duration_sec_idx').on(t.fingerprintDurationSec),
    /**
     * The expiry sweeper's phases 1 and 2, both of which filter
     * `deletedAt: null` alongside the `expiresAt` range
     * (`expirySweeper.ts:243,290`) — so the predicate is folded into the
     * index, the same treatment `catalog.ts` gives `playableTrackFilter()`.
     * A soft-deleted row is exactly the row these two never want.
     */
    index('user_uploads_expires_at_idx')
      .on(t.expiresAt)
      .where(sql`${t.deletedAt} is null`),
    /**
     * The sweeper's phase 3 (`deletedAt <= graceCutoff`), which had NO Mongo
     * index at all: it runs on every tick, unattended, over the one
     * collection this design expects to reach millions of rows. Adding it is
     * "add the index Mongo needed and lacked", the same call `catalog.ts`
     * made for the playability partials.
     */
    index('user_uploads_deleted_at_idx').on(t.deletedAt),
    /**
     * The takedown purge's first leg (`takedown.ts:363`,
     * `find({ matchedTrackId })`) — also unindexed in Mongo, same table, same
     * reasoning.
     */
    index('user_uploads_matched_track_id_idx').on(t.matchedTrackId),
    // Mongo's standalone `{ albumKey: 1 }` is dropped in writing: every
    // reader of it is scoped to one owner first, and the compound index
    // above leads with `owner_oxy_user_id`.
    //
    // Mongo's standalone `{ ownerOxyUserId: 1 }` is dropped for the other
    // reason an index goes away in writing: it is the LEADING COLUMN of the
    // three compound indexes above (and of the unique constraint), and a
    // btree prefix serves an owner-only lookup on its own. Same convention
    // `library.ts` used for `devices.oxy_user_id` — recorded here because a
    // drop nobody wrote down is indistinguishable from a drop nobody noticed.
  ]
);

// ── user_upload_hls_renditions (child of user_uploads) ──────────────────────
//
// The third instance of `HlsRenditionSchema` in this schema, after
// `track_hls_renditions` and `episode_hls_renditions`. Written by
// `services/ingest/ingestUserUpload.ts:129` and read whole
// (`expirySweeper`'s `deleteObjects`, `uploads.controller`'s `.some(...)`);
// identical shape gets identical treatment.
export const userUploadHlsRenditions = pgTable(
  'user_upload_hls_renditions',
  {
    id: generatedId(),
    userUploadId: text()
      .notNull()
      .references(() => userUploads.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    /** A raw S3 object name — see the file-level doc comment on storage keys. */
    manifestKey: text().notNull(),
    bitrateKbps: integer().notNull(),
    encrypted: boolean().notNull(),
  },
  (t) => [
    check('user_upload_hls_renditions_position_check', sql`${t.position} >= 0`),
    unique('user_upload_hls_renditions_user_upload_id_position_key').on(t.userUploadId, t.position),
  ]
);

// ── user_upload_provenance_markers (child of user_uploads) ──────────────────
//
// `ProvenanceReport.markers[]`: the forensic signals a screening found in the
// file. `code` is a stable machine identifier (`itunes.purchase-atoms`), never
// a sentence — it is what a test asserts on and what an appeal quotes, so it
// must survive a copy rewording.
export const userUploadProvenanceMarkers = pgTable(
  'user_upload_provenance_markers',
  {
    id: generatedId(),
    /**
     * No inline `.references()`: drizzle derives an unnamed foreign key's
     * name as `<table>_<column>_<parent>_<parent column>_fk`, which here is
     * 64 bytes — one past Postgres's 63-byte identifier limit, so the
     * database would silently truncate it and every later `DROP CONSTRAINT`
     * by the declared name would fail. Named explicitly below instead.
     */
    userUploadId: text().notNull(),
    position: integer().notNull(),
    code: text().notNull(),
    weight: text({ enum: PROVENANCE_MARKER_WEIGHTS }).notNull(),
    /** The human-readable specifics — which atom, which ISRC — for the evidence chain. */
    detail: text(),
  },
  (t) => [
    check(
      'user_upload_provenance_markers_weight_check',
      sql`${t.weight} in (${sql.raw(inList(PROVENANCE_MARKER_WEIGHTS))})`
    ),
    check('user_upload_provenance_markers_position_check', sql`${t.position} >= 0`),
    unique('user_upload_provenance_markers_user_upload_id_position_key').on(t.userUploadId, t.position),
    foreignKey({
      name: 'user_upload_provenance_markers_user_upload_id_fk',
      columns: [t.userUploadId],
      foreignColumns: [userUploads.id],
    }).onDelete('cascade'),
  ]
);

// ── artist_claims ──────────────────────────────────────────────────────────

export const artistClaims = pgTable(
  'artist_claims',
  {
    id: generatedId(),
    /** A claim has no meaning without the artist it claims — CASCADE. */
    artistId: text()
      .notNull()
      .references(() => catalogEntities.id, { onDelete: 'cascade' }),
    /** The claimant's Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    /** What the claimant offered as proof, in their own words. */
    evidence: text().notNull(),
    status: text({ enum: ARTIST_CLAIM_STATUSES }).notNull().default('pending'),
    resolvedAt: timestamptz(),
    /** The reviewer's Oxy account id — no foreign key. Not `*_id`-suffixed. */
    resolvedBy: text(),
    resolutionNote: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('artist_claims_status_check', sql`${t.status} in (${sql.raw(inList(ARTIST_CLAIM_STATUSES))})`),
    /**
     * Mongoose's `maxlength` on both text fields, expressed where it is
     * actually enforced. The first `maxlength` any task has had to port —
     * this schema already turns Mongoose's `min:`/`max:` validators into
     * CHECKs (`catalog_entities_strike_count_check`,
     * `albums_popularity_check`), so the string analogue follows the same
     * rule rather than being dropped as "app-level validation" or changing
     * the column type to `varchar(n)`.
     */
    check(
      'artist_claims_evidence_length_check',
      sql`char_length(${t.evidence}) <= ${sql.raw(String(CLAIM_EVIDENCE_MAX_LENGTH))}`
    ),
    check(
      'artist_claims_resolution_note_length_check',
      sql`${t.resolutionNote} is null or char_length(${t.resolutionNote}) <= ${sql.raw(String(CLAIM_RESOLUTION_NOTE_MAX_LENGTH))}`
    ),
    /**
     * ONE OPEN claim per claimant per artist — partial, not plain, because
     * the constraint is about the review queue rather than about history: a
     * resubmission after a rejection is legitimate (the claimant found
     * better evidence), while two pending rows for the same pair are the
     * same request reviewed twice. Also serves the `{ artistId, status:
     * 'pending' }` sweep that closes every other open claim when one is
     * approved (`artists.controller.ts:764`).
     */
    uniqueIndex('artist_claims_artist_id_oxy_user_id_pending_key')
      .on(t.artistId, t.oxyUserId)
      .where(sql`${t.status} = 'pending'`),
    /** "My claims", newest first (`listMyArtistClaims`). */
    index('artist_claims_oxy_user_id_created_at_idx').on(t.oxyUserId, t.createdAt.desc()),
    /** The review queue, oldest first (`listArtistClaims`). */
    index('artist_claims_status_created_at_idx').on(t.status, t.createdAt),
    // Mongo's standalone `{ artistId: 1 }` is dropped in writing: no reader
    // queries claims by artist across all statuses — the one artist-scoped
    // query is `status: 'pending'`, which the partial unique index above
    // serves on its leading column.
    //
    // Mongo's standalone `{ oxyUserId: 1 }` and `{ status: 1 }` are dropped
    // as leading-column prefixes of the two compound indexes above:
    // `listMyArtistClaims` filters `oxyUserId` and sorts `createdAt`, and
    // `listArtistClaims` filters `status` and sorts `createdAt`, so each
    // compound index already serves its own column alone.
  ]
);

// ── contribution_attestations ──────────────────────────────────────────────

export const contributionAttestations = pgTable(
  'contribution_attestations',
  {
    id: generatedId(),
    /**
     * ONE row per contributed track, and RESTRICT: this is a legal evidence
     * record whose whole argument is that it outlives the object it
     * describes. A track deletion must force an explicit decision rather
     * than silently taking the evidence with it.
     */
    trackId: text()
      .notNull()
      .references(() => tracks.id, { onDelete: 'restrict' }),
    /** The uploader's Oxy account id — no foreign key. */
    uploaderOxyUserId: text().notNull(),
    /**
     * The exact wording the uploader agreed to, stored verbatim — a later
     * edit to the copy must not change what a past signature says.
     */
    statement: text().notNull(),
    acceptedAt: timestamptz().notNull(),
    /** Request context, server-only — see `PROTECTED_COLUMNS_BY_TABLE`. */
    ip: text(),
    userAgent: text(),
    /** `ProvenanceReport`, flattened; its `markers[]` is a child table below. */
    provenanceReportScore: doublePrecision(),
    provenanceReportVerdict: text({ enum: PROVENANCE_VERDICTS }),
    /**
     * The file's tags as they stood at signing time — server-only, and
     * duplicated from `user_uploads` rather than referenced, because the
     * upload can be deleted and the evidence for a PUBLISHED recording has
     * to outlive it.
     */
    rawTagsFormat: text(),
    rawTagsJson: text(),
    rawTagsTruncated: boolean(),
    rawTagsOriginalByteLength: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'contribution_attestations_provenance_report_verdict_check',
      sql`${t.provenanceReportVerdict} is null or ${t.provenanceReportVerdict} in (${sql.raw(inList(PROVENANCE_VERDICTS))})`
    ),
    unique('contribution_attestations_track_id_key').on(t.trackId),
    /**
     * "Every recording this account contributed" — compliance's termination
     * cascade (`takedown.ts:491`).
     */
    index('contribution_attestations_uploader_oxy_user_id_idx').on(t.uploaderOxyUserId),
  ]
);

// ── contribution_attestation_provenance_markers (child of contribution_attestations) ──
//
// The screening result that was current at signing time. Same shape and same
// treatment as `user_upload_provenance_markers` — the evidence is what makes
// the attestation evidence.
export const contributionAttestationProvenanceMarkers = pgTable(
  'contribution_attestation_provenance_markers',
  {
    id: generatedId(),
    /** Named foreign key below — see `user_upload_provenance_markers` for why. */
    contributionAttestationId: text().notNull(),
    position: integer().notNull(),
    code: text().notNull(),
    weight: text({ enum: PROVENANCE_MARKER_WEIGHTS }).notNull(),
    detail: text(),
  },
  (t) => [
    check(
      'contribution_attestation_provenance_markers_weight_check',
      sql`${t.weight} in (${sql.raw(inList(PROVENANCE_MARKER_WEIGHTS))})`
    ),
    check('contribution_attestation_provenance_markers_position_check', sql`${t.position} >= 0`),
    /**
     * The convention-complete name
     * (`..._contribution_attestation_id_position_key`) is 87 bytes, so this
     * one is shortened to fit Postgres's 63-byte limit rather than being
     * silently truncated by the server.
     */
    unique('contribution_attestation_provenance_markers_position_key').on(
      t.contributionAttestationId,
      t.position
    ),
    foreignKey({
      name: 'contribution_attestation_provenance_markers_attestation_id_fk',
      columns: [t.contributionAttestationId],
      foreignColumns: [contributionAttestations.id],
    }).onDelete('cascade'),
  ]
);

// ── contributor_standings ──────────────────────────────────────────────────

/**
 * The infringement record of an ORDINARY Oxy account — the population the
 * public contribution path creates, which has no artist profile and therefore
 * had no counter, no threshold and no termination until this existed. An
 * enforced repeat-infringer policy is a condition of DMCA safe harbour, and a
 * policy that cannot reach the accounts most likely to infringe is not
 * enforced.
 *
 * Separate from `catalog_entities`' own strike columns on purpose: an
 * artist's strikes are about a catalogue they own, a contributor's are about
 * recordings they attached to somebody else's page. Somebody who is both has
 * a row here AND an artist profile, and each is struck for what it did.
 */
export const contributorStandings = pgTable(
  'contributor_standings',
  {
    id: generatedId(),
    /** One row per Oxy account — no foreign key. */
    oxyUserId: text().notNull(),
    strikeCount: integer().notNull().default(0),
    lastStrikeAt: timestamptz(),
    /** Blocks the PUBLIC contribution path. The private locker is a separate question. */
    uploadsDisabled: boolean().notNull().default(false),
    terminated: boolean().notNull().default(false),
    terminatedAt: timestamptz(),
    terminationReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('contributor_standings_strike_count_check', sql`${t.strikeCount} >= 0`),
    unique('contributor_standings_oxy_user_id_key').on(t.oxyUserId),
    // Mongo's standalone `{ uploadsDisabled: 1 }` and `{ terminated: 1 }` are
    // dropped in writing: `canContributePublicly` and
    // `getContributorStanding` both look this table up BY `oxyUserId` and
    // read the two booleans off the loaded row. Neither is ever a query
    // filter — same shape as `podcasts.claimable`, dropped for the same
    // reason in Task 4.
    //
    // Mongo's standalone `{ oxyUserId: 1 }` is dropped as redundant with the
    // unique constraint above, which Postgres backs with its own btree —
    // every lookup in this file's three call sites is by that column.
  ]
);

// ── contributor_strikes (child of contributor_standings) ────────────────────
//
// Deliberately the same shape as `catalog_entity_strikes`: one policy, two
// populations. A reviewer reading either record sees the same fields, and a
// future change to what a strike records has one shape to change rather than
// two that have drifted.
export const contributorStrikes = pgTable(
  'contributor_strikes',
  {
    id: generatedId(),
    /** Named foreign key below — see `user_upload_provenance_markers` for why. */
    contributorStandingId: text().notNull(),
    reason: text().notNull(),
    /** Mirrors the Mongo subdocument's own `createdAt: { default: Date.now }`. */
    createdAt: createdAt(),
    /**
     * Optional per-strike audit pointer to the offending track. SET NULL, not
     * CASCADE: losing the track must not erase the moderation history — and
     * on this table, unlike the artist one, an erased strike is a
     * repeat-infringer count that silently drops below the threshold.
     */
    trackId: text().references(() => tracks.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('contributor_strikes_contributor_standing_id_idx').on(
      t.contributorStandingId,
      t.createdAt.desc()
    ),
    foreignKey({
      name: 'contributor_strikes_contributor_standing_id_fk',
      columns: [t.contributorStandingId],
      foreignColumns: [contributorStandings.id],
    }).onDelete('cascade'),
  ]
);

// ── copyright_reports ──────────────────────────────────────────────────────

/**
 * Syra's own DMCA pipeline, and NOT CrowdSource's: the universal moderation
 * taxonomy has forty codes across eleven families and none of them is
 * copyright, deliberately, because DMCA carries statutory process and goes to
 * specialists rather than to a randomly drawn jury.
 */
export const copyrightReports = pgTable(
  'copyright_reports',
  {
    id: generatedId(),
    /** DMCA evidence — RESTRICT, the same "must survive the work" reasoning as an attestation. */
    trackId: text()
      .notNull()
      .references(() => tracks.id, { onDelete: 'restrict' }),
    artistId: text()
      .notNull()
      .references(() => catalogEntities.id, { onDelete: 'restrict' }),
    /** Optional — the reporting endpoint is public, so a report may have no account behind it. */
    reporterOxyUserId: text(),
    reason: text().notNull(),
    status: text({ enum: COPYRIGHT_REPORT_STATUSES }).notNull().default('pending'),
    resolvedAt: timestamptz(),
    /** The reviewer's Oxy account id — no foreign key. Not `*_id`-suffixed. */
    resolvedBy: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'copyright_reports_status_check',
      sql`${t.status} in (${sql.raw(inList(COPYRIGHT_REPORT_STATUSES))})`
    ),
    /** "Has this track already been reported" (`reportCopyrightViolation`). */
    index('copyright_reports_track_id_status_idx').on(t.trackId, t.status),
    /**
     * The review queue. ASCENDING on `created_at`, matching the one reader
     * (`listCopyrightReports` sorts oldest first — a report waiting is a work
     * still being distributed), rather than Mongo's declared `-1`; a Postgres
     * btree serves either direction, so the declaration follows the query.
     */
    index('copyright_reports_status_created_at_idx').on(t.status, t.createdAt),
    // Mongo's standalone `{ artistId: 1 }`, `{ artistId: 1, status: 1 }` and
    // `{ reporterOxyUserId: 1 }` are dropped in writing: grepped every
    // reader of this collection — `findOne({ trackId, status })`,
    // `find({ status })`, `findById`, `deleteOne` — and none of them filters
    // by artist or by reporter. The `artist_id` FK's RESTRICT check does a
    // sequential scan here on an artist delete, which no code path performs
    // (RELATIONS.md fact 1).
    //
    // Mongo's standalone `{ trackId: 1 }` and `{ status: 1 }` are dropped as
    // leading-column prefixes of the two compound indexes above, which serve
    // `{ trackId }` and `{ status }` alone as well as the pairs.
  ]
);
