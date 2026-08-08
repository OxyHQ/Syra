import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { inList } from '@oxyhq/db';
import {
  moderationReportColumns,
  moderationReportTableExtras,
  moderationTables,
  type ModerationTables,
} from '@oxyhq/crowdsource-app/postgres';
import {
  MODERATION_ENFORCEMENT_ACTIONS,
  ReportCategory,
  ReportStatus,
  ReportedType,
} from '../../moderation/types';

/**
 * The moderation vertical's tables.
 *
 * Unlike every other schema module here, most of this file is IMPORTED. The
 * outbox, the inbound event log and the enforcement ledger are
 * `@oxyhq/crowdsource-app`'s own tables, in Syra's database — their shape, their
 * indexes and the correctness properties those indexes carry belong to the
 * package, and Syra declaring its own copy is how seven applications end up with
 * seven subtly different outboxes. Syra supplies exactly two things: the union of
 * enforcement actions it can plan, which types the CHECK on `action`, and its own
 * report table.
 *
 * The report table is the interesting half. `moderationReportColumns` returns the
 * columns the package's store queries; Syra spreads them and adds the ONE column
 * that is its own (`status`). That split is enforced by the compiler in the
 * direction that matters: `postgresModerationStore` takes a table typed as
 * carrying every moderation column, so a column dropped from the spread is a
 * compile error at the call site, naming the column. The Mongoose side could not
 * do this — `Model<TReport>` checked the TypeScript type and never the schema
 * paths, which is the defect `zodPathsExistInMongoose.test.ts` exists to catch.
 *
 * ## The CHECK tuples come from the enums, so there is nothing to pin
 *
 * `moderationReportColumnOptions` takes `readonly string[]`, so
 * `Object.values(ReportedType)` reaches it directly and the constraint is derived
 * from the same declaration the application code reads. This is why
 * `moderation/types.ts` needs no `enumsMatchSchema` twin of the kind
 * `db/rooms/types.ts` carries.
 *
 * ## Both index sets are here, and one is redundant on purpose
 *
 * The package always creates `reports_reporter_object_idx` on
 * `(reporter, reported_id, reported_type)`, because intake's duplicate check
 * reads those three and the package cannot know whether an application allows a
 * reporter to file twice. Syra does not — one report per reporter per object is a
 * UNIQUE index rather than a check in a handler, because two concurrent
 * submissions from one client are the ordinary case (a double tap) and a
 * read-then-write leaves exactly the gap where the second lands. So Syra's unique
 * index covers the same three columns, and the package's non-unique one is
 * redundant behind it. Left rather than fought: the package has no way to be told
 * "I declared a unique one", and one extra index on a table with this arrival
 * rate is cheaper than a fork of the extras builder.
 */

/**
 * The value sets the report table constrains itself with.
 *
 * One object passed to BOTH `moderationReportColumns` and
 * `moderationReportTableExtras`, which is the package's own instruction: the
 * CHECK on `reported_type` and the containment CHECK on `categories` are built
 * from the same tuples that bound the columns, and drizzle does not carry those
 * tuples onto a built column (`enumValues` is `undefined` there). Passing the
 * options twice is what stops a column and its constraint drifting apart.
 */
const REPORT_MODERATION = {
  reportedTypes: Object.values(ReportedType),
  categories: Object.values(ReportCategory),
  /** `models/Report.ts`'s `maxlength: 2000`, which the route also slices to. */
  detailsMaxLength: 2_000,
} as const;

/**
 * A report a listener filed in Syra.
 *
 * Two status axes, because they answer two different questions and one field
 * cannot hold both. `local_status` is where the report is in SYRA's pipeline —
 * stored, queued, delivered, failed, closed — and is the package's. `status` is
 * what a jury concluded, and is Syra's own; a report is routinely `submitted`
 * with no verdict yet, and `closed` with a verdict of `dismissed`.
 *
 * This is NOT the copyright flow and the two must never merge. `CopyrightReport`
 * is a real DMCA pipeline with admin resolution, three strikes, artist
 * termination and a `copyrightRemoved` takedown, and it stays exactly where it
 * is — see `moderation/types.ts` for why the taxonomy itself declines the
 * question.
 */
export const reports = pgTable(
  'reports',
  {
    ...moderationReportColumns(REPORT_MODERATION),

    /**
     * What a jury concluded, `pending` until one has.
     *
     * Syra's own column, written by the integration's `reportDecisionExtraFields`
     * hook and by nothing else. The default is what makes intake need no hook at
     * all: a stored report has no verdict, and saying so is the column's job
     * rather than the writer's.
     */
    status: text('status').$type<ReportStatus>().notNull().default(ReportStatus.PENDING),
  },
  (t) => [
    ...moderationReportTableExtras(REPORT_MODERATION)(t),
    check('reports_status_check', sql`${t.status} in (${sql.raw(inList(Object.values(ReportStatus)))})`),
    /**
     * One report per reporter per object — the unique index that IS the rule,
     * rather than a check in the handler that two concurrent submissions race
     * past.
     */
    uniqueIndex('reports_reporter_type_object_key').on(t.reporter, t.reportedType, t.reportedId),
    index('reports_status_idx').on(t.status),
    index('reports_reported_type_idx').on(t.reportedType),
  ],
);

/**
 * The package's three tables, built ONCE.
 *
 * Two calls would produce two distinct sets of drizzle objects for the same SQL
 * names and drizzle-kit would see the schema twice, so the result is exported
 * whole and every reader — the store, the gates, the expiry registry — reads
 * these bindings rather than calling the factory again.
 *
 * **Annotated with `ModerationTables`, and the annotation is load-bearing.**
 * Without it every export below fails `TS2742`: the INFERRED drizzle table type
 * mentions `ModerationOutboxKind` and friends, whose declarations sit at
 * `@oxyhq/crowdsource-app/dist/types` — a path the package's `exports` map does
 * not expose, so `composite: true` cannot write a portable declaration for it.
 * Naming the alias the package DOES export replaces the unnameable inferred type
 * with an indexed access into a public one. Nothing is asserted and nothing is
 * widened; a column dropped upstream is still a compile error here.
 */
const moderation: ModerationTables = moderationTables({
  enforcementActions: MODERATION_ENFORCEMENT_ACTIONS,
});

export const moderationOutbox: ModerationTables['outbox'] = moderation.outbox;
export const moderationEvents: ModerationTables['events'] = moderation.events;
export const moderationEnforcements: ModerationTables['enforcements'] =
  moderation.enforcements;

/**
 * The three tables as the package's own registry fragments expect them.
 *
 * Exported as the grouped object as well as individually because
 * `moderationExpirySweepTargets` and `moderationIdColumnsWithoutForeignKey` take
 * `ModerationTables`, and rebuilding that object at each call site is how two of
 * them end up naming different tables.
 */
export const moderationTableSet: ModerationTables = moderation;
