/**
 * `notification_preferences` and `notification_suppressions`, on drizzle.
 *
 * The two tables `services/notifications/notifier.ts` consults before emitting:
 * which events an account has turned off, and whether it has already been told
 * this particular thing.
 *
 * ## The claim is an INSERT, and it stays one
 *
 * {@link claimSuppression} does not read and then write. The insert IS the
 * decision, exactly as the Mongo version had it: a read-then-write races two
 * concurrent feed refreshes into both deciding to emit, and the unique
 * constraint on `(oxy_user_id, key)` is what makes the race impossible rather
 * than merely unlikely.
 *
 * ## The `on conflict` `schema/user.ts` said this port owed
 *
 * The Mongo version treated ANY duplicate key as "already notified" and never
 * looked at `expiresAt` — so a row past its deadline that the TTL monitor had
 * not yet reaped kept suppressing. Mongo bounded that overshoot at the monitor's
 * ~60s; a Postgres sweep on the 30-minute tick would have bounded it at 30
 * minutes, against a 6-hour default coalescing window: up to ~8% late rather
 * than ~0.3%.
 *
 * `on conflict … do update … where expires_at <= now()` removes the overshoot
 * instead of widening it. An expired row is CLAIMED (its deadline moves forward
 * and the caller may emit); a live one is not (the `where` fails, `do update`
 * touches nothing, and `returning` yields no row). The window is then exact and
 * the sweep is pure housekeeping — it reclaims space, it no longer decides
 * anything. Whether a claim was won is "did `returning` produce a row", which is
 * one statement and therefore still atomic.
 */

import { eq, lte, sql } from 'drizzle-orm';
import { getDb, type DbOrTransaction } from '../postgres';
import {
  notificationPreferences,
  notificationSuppressions,
  type SYRA_NOTIFICATION_EVENTS,
} from '../schema/user';

export type SyraNotificationEvent = (typeof SYRA_NOTIFICATION_EVENTS)[number];

/**
 * Whether an account has turned this event off.
 *
 * An account with no row has every event enabled — the opt-OUT shape the model's
 * own comment describes, which is why a new event type needs no backfill.
 */
export async function isEventDisabled(
  oxyUserId: string,
  event: SyraNotificationEvent,
  db: DbOrTransaction = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ disabledEvents: notificationPreferences.disabledEvents })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.oxyUserId, oxyUserId))
    .limit(1);

  return row?.disabledEvents.includes(event) === true;
}

/**
 * Try to claim a suppression key for `ttlMs`.
 *
 * Returns true when THIS call won the claim (so the caller may emit) and false
 * when a live claim was already held. See this file's doc comment for why an
 * expired claim is won rather than collided with.
 */
export async function claimSuppression(
  oxyUserId: string,
  key: string,
  ttlMs: number,
  db: DbOrTransaction = getDb(),
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlMs);

  const claimed = await db
    .insert(notificationSuppressions)
    .values({ oxyUserId, key, expiresAt })
    .onConflictDoUpdate({
      target: [notificationSuppressions.oxyUserId, notificationSuppressions.key],
      set: { expiresAt },
      // Only an ALREADY-EXPIRED claim may be taken over. `sql\`now()\`` rather
      // than the `expiresAt` computed above: the deadline must be compared
      // against the database's clock at statement time, not this process's.
      setWhere: lte(notificationSuppressions.expiresAt, sql`now()`),
    })
    .returning({ id: notificationSuppressions.id });

  return claimed.length > 0;
}

/**
 * `notification_preferences` has no writer, in this module or anywhere else.
 *
 * `isEventDisabled` above is its only production reader, and nothing in the repo
 * creates or updates a row — no route exposes the event taxonomy, so every
 * account currently has every Syra event enabled by having no row at all. That
 * is the opt-OUT design working as intended rather than a gap in this port, but
 * it does mean the table is read-only until someone builds the settings screen.
 * A `setDisabledEvents` written here now would have no caller but the test that
 * covers it, so the suite seeds rows with a plain insert instead.
 */
