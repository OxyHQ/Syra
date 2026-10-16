/**
 * Oxy Files bookkeeping (OxyHQ/oxy ADR 0041).
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
 *   sends to Oxy (ADR 0041 D6) — the safety net under the outbox.
 * - `oxy_file_events` deduplicates Oxy's file events (at-least-once delivery).
 * - `oxy_files_legacy_reads` counts reads still answered from the old bucket,
 *   per day and kind — the number the bucket's retirement is gated on.
 */

import { sql } from 'drizzle-orm';
import {
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
] as const;

export type OxyReferenceEntityType = (typeof OXY_REFERENCE_ENTITY_TYPES)[number];

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
