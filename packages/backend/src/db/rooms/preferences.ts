/**
 * `room_user_preferences` — one row per Oxy account, holding the live-presence
 * badge preference.
 *
 * The smallest table in the vertical and the only one with no relationships at
 * all: a unique `oxy_user_id` and one enum column.
 */

import { eq, inArray } from 'drizzle-orm';
import { getDb, type DbOrTransaction } from '../postgres';
import { roomUserPreferences } from '../schema/rooms';
import { DEFAULT_LIVE_VISIBILITY, type LiveVisibility } from './types';

/**
 * One user's preference, or the default when they have never set one.
 *
 * Returns the DEFAULT rather than `undefined` so the absent-row case is answered
 * in one place: `GET /me/presence-preference` and the badge feed both mean
 * "active" by a missing row, and having each spell its own `?? 'active'` is two
 * chances to spell it differently.
 */
export async function findLiveVisibility(
  oxyUserId: string,
  db: DbOrTransaction = getDb(),
): Promise<LiveVisibility> {
  const [row] = await db
    .select({ liveVisibility: roomUserPreferences.liveVisibility })
    .from(roomUserPreferences)
    .where(eq(roomUserPreferences.oxyUserId, oxyUserId))
    .limit(1);

  return (row?.liveVisibility as LiveVisibility | undefined) ?? DEFAULT_LIVE_VISIBILITY;
}

/**
 * Preferences for many users in ONE query, as a map. Users with no row are
 * absent from the map; the caller applies {@link DEFAULT_LIVE_VISIBILITY}, which
 * is what keeps this a single batched read rather than one query per candidate.
 */
export async function findLiveVisibilities(
  oxyUserIds: readonly string[],
  db: DbOrTransaction = getDb(),
): Promise<Map<string, LiveVisibility>> {
  const byUserId = new Map<string, LiveVisibility>();
  if (oxyUserIds.length === 0) return byUserId;

  const rows = await db
    .select({
      oxyUserId: roomUserPreferences.oxyUserId,
      liveVisibility: roomUserPreferences.liveVisibility,
    })
    .from(roomUserPreferences)
    .where(inArray(roomUserPreferences.oxyUserId, [...oxyUserIds]));

  for (const row of rows) {
    byUserId.set(row.oxyUserId, row.liveVisibility as LiveVisibility);
  }
  return byUserId;
}

/**
 * Set a user's preference, creating the row if they have none — Mongo's
 * `findOneAndUpdate(…, { upsert: true })`, as a real `ON CONFLICT` against the
 * unique `oxy_user_id` rather than the find-then-insert race it papered over.
 */
export async function setLiveVisibility(
  oxyUserId: string,
  liveVisibility: LiveVisibility,
  db: DbOrTransaction = getDb(),
): Promise<LiveVisibility> {
  const [row] = await db
    .insert(roomUserPreferences)
    .values({ oxyUserId, liveVisibility })
    .onConflictDoUpdate({
      target: roomUserPreferences.oxyUserId,
      set: { liveVisibility, updatedAt: new Date() },
    })
    .returning({ liveVisibility: roomUserPreferences.liveVisibility });

  return row.liveVisibility as LiveVisibility;
}
