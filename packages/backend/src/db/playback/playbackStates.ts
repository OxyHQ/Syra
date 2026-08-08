/**
 * `playback_states` reads and writes — one row per account, the server's
 * authoritative "what is playing".
 *
 * ## `null` is a value here, and it has to be written deliberately
 *
 * Mongoose's document API let a caller write `state.activeDeviceId = undefined`
 * and have `.save()` emit `$unset`, so "clear this field" and "leave this field
 * alone" were spelled the same way. Drizzle draws the line the other way round:
 * an `undefined` in a `set` object is DROPPED from the statement, and only an
 * explicit `null` clears a column.
 *
 * That distinction is load-bearing in exactly one place, and it is a real
 * behaviour rather than a style point — `handleDeviceDisconnect`'s failover
 * clears `activeDeviceId` when the last active device goes away. Ported
 * literally, `undefined` would have left the departed device named as active
 * forever, with the state paused and pointing at a client that is gone.
 * {@link PlaybackStatePatch} therefore admits `null` on every nullable column,
 * and callers pass it on purpose.
 *
 * The inverse case is just as deliberate: `setNowPlaying` OMITS a key when its
 * input is `undefined`, which is how "preserve the existing value" is spelled.
 * Both meanings are reachable, so neither can be inferred — the caller says
 * which.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../postgres';
import { playbackStates } from '../schema/library';

export type PlaybackStateRow = typeof playbackStates.$inferSelect;

/**
 * A partial update. `undefined`/absent leaves a column alone; `null` clears it.
 * Derived from the insert type rather than hand-listed, so a column added to
 * the table cannot be silently un-writable here.
 */
export type PlaybackStatePatch = Partial<Omit<typeof playbackStates.$inferInsert, 'id' | 'oxyUserId'>>;

/**
 * This account's playback state, created with column defaults if absent.
 *
 * `onConflictDoNothing` + a follow-up read rather than a bare
 * `select`-then-`insert`: two sockets from the same account connecting at once
 * both find nothing and both insert, and `playback_states_oxy_user_id_key`
 * turns the loser into a thrown unique violation. Doing nothing on conflict
 * makes the race a no-op instead.
 */
export async function findOrCreatePlaybackState(oxyUserId: string): Promise<PlaybackStateRow> {
  const [inserted] = await getDb()
    .insert(playbackStates)
    .values({ oxyUserId })
    .onConflictDoNothing({ target: playbackStates.oxyUserId })
    .returning();

  if (inserted) return inserted;

  // The conflict branch: somebody else's row (or our own earlier one) is there.
  const [existing] = await getDb()
    .select()
    .from(playbackStates)
    .where(eq(playbackStates.oxyUserId, oxyUserId))
    .limit(1);

  return existing;
}

/**
 * Apply a patch and return the stored row.
 *
 * `updated_at` is left to the column's `$onUpdate`, which fires for a
 * `db.update()` — the services read it back to stamp `ConnectPlaybackState`,
 * so it has to move on every write or clients cannot order two states.
 */
export async function updatePlaybackState(
  oxyUserId: string,
  patch: PlaybackStatePatch
): Promise<PlaybackStateRow> {
  const [row] = await getDb()
    .update(playbackStates)
    .set(patch)
    .where(eq(playbackStates.oxyUserId, oxyUserId))
    .returning();

  return row;
}
