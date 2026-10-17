/**
 * Oxy Files bookkeeping (OxyHQ/oxy ADR 0043).
 *
 * Syra's images live in Oxy Files: catalogue artwork as files the SYRA
 * application owns, a person's uploads as files their account owns. Oxy only
 * knows a file is in use because Syra says so (`file_references`), and an
 * application-owned file nobody references is moved to Oxy's trash after 24
 * hours and purged 30 days later. So every use Syra makes of a file has to reach
 * Oxy, durably — these tables are how.
 *
 * - `oxy_file_reference_ops` is the OUTBOX. It is written by database triggers
 *   (migration `0034_oxy_file_reference_triggers`) in the SAME transaction as the
 *   row that starts or stops using a file, so no write path can forget it and no
 *   crash can lose it. One row per (file, entity type, entity): the latest intent
 *   wins, and `version` lets the drainer tell an intent it sent from one written
 *   while it was in flight. `services/oxyFiles/referenceOutbox.ts` drains it.
 * - `oxy_file_reconcile_runs` records the nightly inventory each entity type
 *   sends to Oxy (ADR 0043 D6) — the safety net under the outbox.
 * - `oxy_file_events` deduplicates Oxy's file events (at-least-once delivery).
 * - `oxy_files_legacy_reads` counts reads still answered from the old bucket,
 *   per day and kind — the number the bucket's retirement is gated on.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';
import { createdAt, inList, timestamptz, updatedAt } from '@oxy.so/db';

/**
 * What Syra tells Oxy it uses a file FOR — the `entity_type` of a reference.
 * One per table that points at an image; `services/oxyFiles/referenceRegistry.ts`
 * maps each to its columns, and the triggers are created from the same list (a
 * test compares them).
 */
export const OXY_REFERENCE_ENTITY_TYPES = [
  'catalog_entity',
  'album',
  'track',
  'user_upload',
  'playlist',
  'podcast',
  'episode',
  'house',
  'room',
  'series',
  // Audio (ADR 0043 stage 4c): each audio-bearing row's own Oxy file, under an
  // entity type of its own so its reconciliation never mixes with the row's
  // images.
  'track_audio',
  'user_upload_audio',
  'episode_audio',
  'recording',
] as const;

export type OxyReferenceEntityType = (typeof OXY_REFERENCE_ENTITY_TYPES)[number];

/**
 * What Syra knows about an Oxy AUDIO file's state, from Oxy's file events:
 * `active` is servable; `unavailable` is trashed or deleted (its owner's act,
 * or Oxy's); `blocked` is taken down after a content claim. Anything but
 * `active` is never played — and never answered from the legacy bucket either,
 * because the event is a decision about the BYTES, not about a copy of them.
 */
export const OXY_AUDIO_FILE_STATUSES = ['active', 'unavailable', 'blocked'] as const;
export type OxyAudioFileStatus = (typeof OXY_AUDIO_FILE_STATUSES)[number];

/** Who owns an Oxy audio file: the Syra application, or a person's account. */
export const OXY_AUDIO_OWNER_KINDS = ['application', 'account'] as const;
export type OxyAudioOwnerKind = (typeof OXY_AUDIO_OWNER_KINDS)[number];

export const OXY_REFERENCE_OPS = ['add', 'remove'] as const;
export type OxyReferenceOp = (typeof OXY_REFERENCE_OPS)[number];

/** The kinds of image read still served from the legacy bucket. */
export const LEGACY_IMAGE_READ_KINDS = [
  'image_asset',
  'house_avatar',
  'house_cover',
  'room_stream_image',
  'series_cover',
] as const;

export type LegacyImageReadKind = (typeof LEGACY_IMAGE_READ_KINDS)[number];

export const oxyFileReferenceOps = pgTable(
  'oxy_file_reference_ops',
  {
    /** An Oxy file id — another service's key, no foreign key. */
    fileId: text().notNull(),
    entityType: text({ enum: OXY_REFERENCE_ENTITY_TYPES }).notNull(),
    /** The id of the row in the table `entity_type` names. Polymorphic, so no foreign key. */
    entityId: text().notNull(),
    op: text({ enum: OXY_REFERENCE_OPS }).notNull(),
    /** Bumped by every new intent for this key; the drainer deletes only the version it sent. */
    version: integer().notNull().default(1),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamptz().notNull().defaultNow(),
    /** A drainer's lease. Another instance may take the row once it passes. */
    claimedUntil: timestamptz(),
    lastError: text(),
    /** Set when the drainer gave up; the nightly reconciliation repairs what it left. */
    deadAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.fileId, t.entityType, t.entityId] }),
    check(
      'oxy_file_reference_ops_op_check',
      sql`${t.op} in (${sql.raw(inList(OXY_REFERENCE_OPS))})`,
    ),
    check(
      'oxy_file_reference_ops_entity_type_check',
      sql`${t.entityType} in (${sql.raw(inList(OXY_REFERENCE_ENTITY_TYPES))})`,
    ),
    check('oxy_file_reference_ops_attempts_check', sql`${t.attempts} >= 0`),
    // The drainer's claim: due, live rows, oldest first.
    index('oxy_file_reference_ops_due_idx').on(t.nextAttemptAt).where(sql`${t.deadAt} is null`),
    // The expiry sweep's target (`db/expiry.ts`).
    index('oxy_file_reference_ops_dead_at_idx').on(t.deadAt),
  ],
);

export const oxyFileReconcileRuns = pgTable(
  'oxy_file_reconcile_runs',
  {
    entityType: text({ enum: OXY_REFERENCE_ENTITY_TYPES }).primaryKey(),
    startedAt: timestamptz().notNull(),
    finishedAt: timestamptz(),
    dryRun: boolean().notNull(),
    added: integer(),
    removed: integer(),
    unchanged: integer(),
    refused: integer(),
    lastError: text(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'oxy_file_reconcile_runs_entity_type_check',
      sql`${t.entityType} in (${sql.raw(inList(OXY_REFERENCE_ENTITY_TYPES))})`,
    ),
  ],
);

export const oxyFileEvents = pgTable(
  'oxy_file_events',
  {
    /** Oxy's event id — the same for every application told of one change. */
    eventId: text().primaryKey(),
    type: text().notNull(),
    /** An Oxy file id — another service's key, no foreign key. */
    fileId: text().notNull(),
    receivedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [index('oxy_file_events_received_at_idx').on(t.receivedAt)],
);

export const oxyFilesLegacyReads = pgTable(
  'oxy_files_legacy_reads',
  {
    day: date({ mode: 'string' }).notNull(),
    kind: text({ enum: LEGACY_IMAGE_READ_KINDS }).notNull(),
    reads: integer().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind] }),
    check(
      'oxy_files_legacy_reads_kind_check',
      sql`${t.kind} in (${sql.raw(inList(LEGACY_IMAGE_READ_KINDS))})`,
    ),
    check('oxy_files_legacy_reads_reads_check', sql`${t.reads} >= 0`),
  ],
);

/**
 * One row per Oxy AUDIO file Syra stored or imported (ADR 0043 stage 4c) —
 * keyed by the FILE, because Oxy's events and play sessions are per file and
 * several rows may share one (a person's same bytes in two uploads, one
 * enclosure URL imported once).
 *
 * The rows that USE a file name it in their own column (`tracks.audio_file_id`,
 * `user_uploads.audio_file_id`, `episodes.audio_file_id`,
 * `recordings.oxy_file_id`); those columns are what the reference triggers
 * watch. This table is what Syra knows about the file itself: whether it may be
 * served, whether Oxy finished its audio ladder, and the hash it was verified
 * against when it was stored.
 */
export const oxyAudioFiles = pgTable(
  'oxy_audio_files',
  {
    /** An Oxy file id — another service's key, no foreign key. */
    fileId: text().primaryKey(),
    status: text({ enum: OXY_AUDIO_FILE_STATUSES }).notNull().default('active'),
    ownerKind: text({ enum: OXY_AUDIO_OWNER_KINDS }).notNull(),
    /** The owning account for `ownerKind = 'account'`; an Oxy account id, no foreign key. */
    ownerOxyUserId: text(),
    /** The SHA-256 Oxy returned, checked against the bytes Syra sent (or `null` for an import). */
    sha256: text(),
    mime: text().notNull(),
    sizeBytes: bigint({ mode: 'number' }),
    /** When Oxy's audio-only HLS ladder was seen ready (`hlsReadyAt`); `null` until then. */
    hlsReadyAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'oxy_audio_files_status_check',
      sql`${t.status} in (${sql.raw(inList(OXY_AUDIO_FILE_STATUSES))})`,
    ),
    check(
      'oxy_audio_files_owner_kind_check',
      sql`${t.ownerKind} in (${sql.raw(inList(OXY_AUDIO_OWNER_KINDS))})`,
    ),
    check(
      'oxy_audio_files_owner_check',
      sql`(${t.ownerKind} = 'account') = (${t.ownerOxyUserId} is not null)`,
    ),
    check('oxy_audio_files_size_check', sql`${t.sizeBytes} is null or ${t.sizeBytes} >= 0`),
  ],
);
