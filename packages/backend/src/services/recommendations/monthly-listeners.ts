import { sql } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { PLAY_COMPLETION_THRESHOLD } from './engagement';

export const MONTHLY_LISTENER_WINDOW_DAYS = 28;
const WINDOW_MS = MONTHLY_LISTENER_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Unique Oxy accounts with a qualified music listen in [asOf - 28 days, asOf).
 * This reuses the existing engagement threshold, not followers or total plays.
 * Guests only receive previews and are not fingerprinted. Podcasts, radio-stream
 * sessions and private locker files never enter listening_events.
 *
 * Primary artists use the event's historical attribution. Resolved performing
 * credits count as well; composers/producers and unlinked names do not. UNION
 * deduplicates an account across tracks, replays and multiple performer roles.
 * A single transaction refreshes zeros too, so an inactive artist ages out.
 * The advisory lock prevents concurrent passes even when Redis is unavailable.
 */
export async function refreshMonthlyListeners(asOf = new Date()): Promise<number> {
  if (!Number.isFinite(asOf.getTime())) throw new Error('Invalid monthly-listener cutoff');
  const since = new Date(asOf.getTime() - WINDOW_MS);
  return getDb().transaction(async (transaction) => {
    const [lock] = await transaction.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext('syra:monthly-listeners')) as acquired`,
    );
    if (!lock?.acquired) return 0;
    await transaction.execute(sql`set local statement_timeout = '120s'`);
    const [result] = await transaction.execute<{ updated: number }>(sql`
      with qualified as (
        select oxy_user_id, artist_id, track_id
        from listening_events
        where played_at >= ${since.toISOString()}::timestamptz and played_at < ${asOf.toISOString()}::timestamptz
          and completion >= ${PLAY_COMPLETION_THRESHOLD} and not skipped
      ), audience as (
        select oxy_user_id, artist_id from qualified
        union
        select qualified.oxy_user_id, credits.catalog_entity_id
        from qualified
        join track_credits credits on credits.track_id = qualified.track_id
        where credits.catalog_entity_id is not null
          and lower(trim(credits.role)) in ('artist', 'albumartist', 'performer', 'featured', 'vocalist')
      ), counts as (
        select artist_id, count(distinct oxy_user_id)::integer as listeners
        from audience group by artist_id
      ), updated as (
        update catalog_entities artist
        set stats_monthly_listeners = coalesce(counts.listeners, 0),
            stats_monthly_listeners_computed_at = ${asOf.toISOString()}::timestamptz
        from catalog_entities candidate
        left join counts on counts.artist_id = candidate.id
        where artist.id = candidate.id and artist.type = 'artist'
        returning artist.id
      ) select count(*)::integer as updated from updated
    `);
    return result?.updated ?? 0;
  });
}
