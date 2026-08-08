/**
 * Expiry Sweep registry — the replacement for Mongo TTL indexes
 *
 * Postgres has no TTL index. Every table that needs one adds an entry here
 * rather than growing its own cleanup path. The registry stays here because
 * it would name THIS schema's own tables; the mechanism that sweeps it
 * (`sweepExpiredRows`, `sweepAllExpiredRows`, `ExpirySweepTarget`) lives in
 * `@oxyhq/db/expiry` — see that module's doc comment for the full shape and
 * for why a TTL index is a behaviour of the SOURCE that does not survive a
 * Mongo-to-Postgres port on its own.
 *
 * ## THE RULE, because it is the quietest failure in this migration
 *
 * **A TTL index is a behaviour of the SOURCE that does not survive the port.**
 * Mongo reaps; Postgres does not. A table ported without a registry entry
 * grows FOREVER — no error, no failing test, no symptom of any kind until
 * disk. It is structurally invisible because the thing doing the work was
 * never in this code to be missed: there is no deleted call site, no orphaned
 * function, nothing a reviewer diffing the port would see go absent.
 *
 * So porting a collection is not done when its schema and migration exist. If
 * its Mongoose model declares `expireAfterSeconds`, it is done only once a
 * matching entry exists here.
 *
 * THAT IS GATED, and no longer by a hand grep. `__tests__/gates.test.ts`
 * ("accounts for every Mongoose TTL index") WALKS `src/models/*.ts` for
 * `<Model>Schema.index({ field: 1 }, { … expireAfterSeconds … })` and compares
 * what it finds against a model→port map, then compares the covered half of
 * that map against the targets below. A vertical that ports a TTL-bearing
 * model without adding an entry here fails there, naming the model. Only the
 * model→column correspondence is hand-maintained — a human has to say which
 * Postgres column a Mongo field became — while the SET of declarations comes
 * from the files, which is the half that used to be a grep in somebody's
 * report.
 *
 * The map holds FOUR entries and only TWO are still declared in `src/models/`,
 * because a ported model's file is deleted: Task 15 removed
 * `ListeningEvent.ts` and `NotificationSuppression.ts`. The gate derives which
 * side an entry belongs on from whether its model file still EXISTS rather
 * than from a hand-kept flag, so the migration succeeding cannot be mistaken
 * for a TTL deleted by accident — and a declaration surviving a model the map
 * calls deleted fails too. `ModerationOutbox`/`ModerationEvent` are the two
 * still declared, mapped to a deferred sentinel that is deliberately NOT
 * counted as covered.
 *
 * The gate reads one spelling of a TTL declaration — the only one this repo
 * uses, not the only one Mongoose accepts. See its own comment for the four
 * shapes it would miss and why a miss is SILENT; adding a target in an
 * unusual shape means checking that comment first.
 *
 * `findUnsupportedExpiryColumns` (`@oxyhq/db/assert`) reads the real Postgres
 * catalogue against whatever lands here, so an entry added without its
 * supporting index fails the gate rather than silently costing a full table
 * scan on every sweep. `__tests__/gates.test.ts` drives it against a REAL
 * migrated database, which is the only thing that can validate a catalogue
 * query, and its Task 7 block adds a planner probe on the sweep's own
 * statement — an index can exist and still not be usable.
 *
 * ## THE SWEEP IS WIRED, and Task 15 is what made it load-bearing
 *
 * `sweepAllExpiredRows` is called from `services/recommendations/scheduler.ts`,
 * on the same 30-minute Redis-locked maintenance tick as the two recommendation
 * jobs that read these tables.
 *
 * It was deliberately unwired before that, and the reason it could no longer
 * stay so is the point: while both tables were empty and Mongo's TTL monitor was
 * still reaping the live store, an inert registry cost nothing. Task 15 ported
 * both writers, so these tables ARE the live store — and an unwired registry
 * from that moment means both grow FOREVER, with no error, no failing test and
 * no symptom of any kind until disk. That is the failure this file's own rule
 * calls structurally invisible, and porting the writer is exactly when it
 * becomes real.
 *
 * **`listening_events` sets the batch size.** It is the only table here with a
 * high arrival rate (one row per play), and `sweepExpiredRows`' per-call
 * ceiling is `batchSize × maxBatches` — 1,000 × 50 = 50,000 rows by default.
 * A sweep must delete at least as many rows per day as arrive, or the backlog
 * grows without bound while every individual run reports success with
 * `truncated: true`: at the 30-minute tick that default is 48 × 50,000 = 2.4M
 * rows/day of headroom, which is the number to re-check — not the defaults to
 * copy — if play volume ever approaches it. `truncated` is returned per table
 * for exactly this reason, and the scheduler logs it at WARN.
 */

import type { ExpirySweepTarget } from '@oxyhq/db/expiry';
import { moderationExpirySweepTargets } from '@oxyhq/crowdsource-app/postgres';
import { moderationTableSet } from './schema/moderation';
import {
  LISTENING_EVENT_RETENTION_SECONDS,
  listeningEvents,
  notificationSuppressions,
} from './schema/user';

/**
 * Every table that had a Mongo TTL index. A table with an expiry column but no
 * entry here is never swept.
 *
 * Both entries are checked for INTENT, not merely replicated — `@oxyhq/db`'s
 * own instruction, because a TTL index deletes unconditionally and can be
 * written to mean "mark expired":
 *
 *  - Deleting a `notification_suppressions` row is what RE-ARMS a notification.
 *    The row is a claim ticket, not history; the only cost of deleting one is
 *    that the same notification may be sent again, which is exactly what
 *    `expiresAt` passing is supposed to permit. This entry no longer carries the
 *    caveat it used to: `claimSuppression` read no deadline at all under
 *    Mongoose, so an unswept row kept suppressing past its own, and the sweep's
 *    lag was therefore load-bearing. Task 15's `on conflict … where expires_at
 *    <= now()` (`db/user/notifications.ts`) CLAIMS an expired row rather than
 *    colliding with it, so this sweep is now pure housekeeping — it reclaims
 *    space and decides nothing.
 *  - Deleting a `listening_events` row costs raw signal that has already been
 *    folded into the durable aggregates (`user_taste_profiles`,
 *    `catalog_relations`) — the model's own doc comment says so, and the
 *    co-occurrence job's 60-day lookback means a 90-day-old event is already
 *    outside the window it reads. The OTHER reader
 *    (`getMadeForYou`, via `findRecentTrackIds`) does not filter by time at all
 *    and can read an unswept row; that is harmless for what it does with it, and
 *    `schema/user.ts`'s file-level doc comment spells out why rather than
 *    claiming a filter that is not there. Neither table holds unprocessed
 *    work, so neither can lose a backlog to a stalled consumer plus this sweep.
 */
export const EXPIRY_SWEEP_TARGETS: readonly ExpirySweepTarget[] = [
  {
    table: notificationSuppressions,
    column: notificationSuppressions.expiresAt,
    // `expireAfterSeconds: 0` — the column IS the deadline
    // (`models/NotificationSuppression.ts:37`).
    retentionSeconds: 0,
    reason:
      'A suppression claim past its own expiresAt; deleting it re-arms the notification, which is ' +
      'what the deadline means.',
  },
  {
    table: listeningEvents,
    column: listeningEvents.playedAt,
    // `expireAfterSeconds: LISTENING_EVENT_TTL_SEC`
    // (`models/ListeningEvent.ts:95`), read from the schema module so the two
    // cannot drift.
    retentionSeconds: LISTENING_EVENT_RETENTION_SECONDS,
    reason:
      'A raw play older than 90 days, already folded into the taste profile and relation graph. ' +
      "Outside the co-occurrence job's 60-day window; the other reader does not filter by time at " +
      'all and can read an unswept row, harmlessly — see schema/user.ts.',
  },
  /**
   * The moderation outbox and inbound event log, as a FRAGMENT the package
   * supplies rather than two entries written here.
   *
   * Same division as everywhere else in this migration: `@oxyhq/db` holds the
   * sweep MECHANISM, the consumer holds the REGISTRY — and here the consumer's
   * registry names tables the consumer does not own. `@oxyhq/crowdsource-app` is
   * the only place that can say what sweeping either one COSTS (the outbox holds
   * undelivered work; the event log holds the dedupe claim and the audit trail),
   * so it states the reasons and Syra spreads them in. Both were
   * `expireAfterSeconds: 0` on an `expiresAt` the writer computes, so
   * `retentionSeconds` is 0 on both: the column already is the deadline.
   *
   * `models/ModerationOutbox.ts` and `models/ModerationEvent.ts` are the two TTL
   * declarations `gates.test.ts` mapped to a deferred sentinel while this vertical
   * was still on Mongo. This entry is what closes them.
   */
  ...moderationExpirySweepTargets(moderationTableSet),
];
