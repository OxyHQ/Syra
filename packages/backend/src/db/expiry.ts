/**
 * Expiry Sweep registry
 *
 * Postgres has no TTL index. Every table that needs one adds an entry here
 * rather than growing its own cleanup path. The registry stays here because
 * it would name THIS schema's own tables; the mechanism that sweeps it
 * (`sweepExpiredRows`, `sweepAllExpiredRows`, `ExpirySweepTarget`) lives in
 * `@oxy.so/db/expiry` — see that module's doc comment for the full shape.
 *
 * ## THE RULE, because it is the quietest failure in this schema
 *
 * **Nothing reaps a table that has no entry here.** A table that needs rows to
 * stop existing and has no registry entry grows FOREVER — no error, no failing
 * test, no symptom of any kind until disk. It is structurally invisible because
 * there is no call site to go missing.
 *
 * ## WHAT IS AND IS NOT GATED — read this before adding a table
 *
 * What holds the registry, all of it against Postgres:
 *
 *  - `__tests__/gates.test.ts`, "registers every expiry target with its own
 *    retention" — the exact, ORDERED list of
 *    `table.column:retentionSeconds`, not a count. A target pointed at the wrong
 *    column or carrying the wrong retention is caught; both are mistakes that
 *    leave rows either immortal or deleted early, and neither moves a length.
 *  - `findUnsupportedExpiryColumns` (`@oxy.so/db/assert`), driven against a REAL
 *    migrated database, so a target added without a supporting index fails
 *    rather than silently costing a full scan every tick.
 *  - `db/user/__tests__/user.explain.test.ts` — an EXPLAIN probe per target on
 *    the sweep's own statement (an index can exist and still not be usable),
 *    plus a length parity check against its own index map.
 *  - `gates.test.ts`'s "keeps user_uploads.expires_at OUT of the blind expiry
 *    sweep", the negative direction.
 *
 * **What nothing gates: that a NEW table which ought to be swept gets an entry.**
 * No check derives the required SET from anything; the list below is what the
 * assertions compare against, so a table that needs expiry and is simply never
 * added here is invisible to all of them, which is precisely this file's own
 * "grows FOREVER, with no symptom of any kind until disk".
 *
 * That gap is deliberately NOT closed with a scanner over expiry-shaped columns,
 * and `user_uploads.expires_at` is why: it is exactly that shape and must NEVER
 * be registered, because a blind row delete orphans the file's S3 objects and
 * skips the T−14d warning the retention policy promises. Any such scanner has to
 * carry an exemption list from its first commit, and an exemption list is the
 * thing this repo has repeatedly found rots. Adding a table? Ask whether its rows
 * must stop existing, and answer it here.
 *
 * `findUnsupportedExpiryColumns` (`@oxy.so/db/assert`) reads the real Postgres
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
 * An unwired registry means every table here grows FOREVER, with no error, no
 * failing test and no symptom of any kind until disk — the failure this file's
 * own rule calls structurally invisible.
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

import type { ExpirySweepTarget } from '@oxy.so/db/expiry';
import { moderationExpirySweepTargets } from '@crowdsource.you/core/outbox/postgres';
import { moderationTableSet } from './schema/moderation';
import { episodeIngestTickets } from './schema/podcasts';
import {
  LISTENING_EVENT_RETENTION_SECONDS,
  listeningEvents,
  notificationSuppressions,
} from './schema/user';

/**
 * Every table whose rows expire. A table with an expiry column but no entry
 * here is never swept.
 *
 * Each entry is checked for INTENT — `@oxy.so/db`'s own instruction, because a
 * sweep deletes unconditionally and an expiry column can be written to mean
 * "mark expired":
 *
 *  - Deleting a `notification_suppressions` row is what RE-ARMS a notification.
 *    The row is a claim ticket, not history; the only cost of deleting one is
 *    that the same notification may be sent again, which is exactly what
 *    `expiresAt` passing is supposed to permit. The claim's `on conflict … where
 *    expires_at <= now()` (`db/user/notifications.ts`) CLAIMS an expired row
 *    rather than colliding with it, so this sweep is pure housekeeping — it reclaims
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
    // The column IS the deadline.
    retentionSeconds: 0,
    reason:
      'A suppression claim past its own expiresAt; deleting it re-arms the notification, which is ' +
      'what the deadline means.',
  },
  {
    table: listeningEvents,
    column: listeningEvents.playedAt,
    // Read from the schema module so the two cannot drift.
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
   * Same division as everywhere else in this schema: `@oxy.so/db` holds the
   * sweep MECHANISM, the consumer holds the REGISTRY — and here the consumer's
   * registry names tables the consumer does not own. `@crowdsource.you/core/outbox` is
   * the only place that can say what sweeping either one COSTS (the outbox holds
   * undelivered work; the event log holds the dedupe claim and the audit trail),
   * so it states the reasons and Syra spreads them in. Both expire on an
   * `expiresAt` the writer computes, so `retentionSeconds` is 0 on both: the
   * column already is the deadline.
   */
  {
    table: episodeIngestTickets,
    column: episodeIngestTickets.expiresAt,
    // The column IS the deadline, so nothing is retained past it.
    retentionSeconds: 0,
    reason:
      'A redemption record past its own expiresAt. Pure housekeeping: the redemption claim treats a ' +
      'MISSING row as REFUSED, so deleting one can only ever narrow access, never widen it — and the ' +
      'JWT carrying the same deadline has expired by then anyway. Unswept, this table grows by one ' +
      'row per episode draft forever.',
  },
  ...moderationExpirySweepTargets(moderationTableSet),
];
