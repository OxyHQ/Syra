/**
 * Who may see which show and which episode — the podcast vertical's predicates,
 * in one place, the way `db/catalog/visibility.ts` holds the catalogue's.
 *
 * Three rules, and they are genuinely different from each other:
 *
 *  - {@link activeShowFilter} — a show is browsable/searchable iff
 *    `status = 'active'`. Does not vary by viewer.
 *  - {@link episodeVisibilityFilter} — an episode's own status gate DOES vary by
 *    viewer: the show's owner sees `processing`/`failed` episodes, everyone else
 *    sees only `ready` ones.
 *  - {@link publiclyPlayableEpisodeFilter} — a cross-show listing additionally
 *    requires the episode to be PLAYABLE (Syra-hosted, or an RSS episode that
 *    actually carries an enclosure) and its SHOW to still be active.
 *
 * ## `hiddenShowEpisodeFilter` becomes a semi-join, and it is not merely faster
 *
 * `utils/podcastDiscovery.ts` ran a separate `find({ status: { $ne: 'active' }
 * }).select('_id')` and fed the ids into `$nin` — a two-query dance whose own
 * doc comment defends it as "non-active shows are rare, so the id set is small".
 * That reasoning is a property of today's data, not of the query, and it fails
 * quietly the day a bulk takedown lands: the id list grows without bound and
 * gets embedded in every subsequent query.
 *
 * {@link showIsActive} is the same rule as a correlated `EXISTS` on the primary
 * key, which is one index probe per candidate row and needs no first query at
 * all. The two agree on every row that can exist — an episode pointing at a
 * MISSING show would be kept by `$nin` and dropped by `EXISTS`, but
 * `episodes.podcast_id` is `NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE`,
 * so no such row is representable. That is the constraint doing the work the
 * Mongo version had to assume.
 */

import { and, eq, exists, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../postgres';
import { episodes, podcasts } from '../schema/podcasts';

/** Browsable/searchable shows. */
export function activeShowFilter(): SQL {
  return eq(podcasts.status, 'active');
}

/**
 * A show hidden from discovery — the negation {@link activeShowFilter} does not
 * cover, and the one `podcasts_inactive_idx` exists for.
 */
export function hiddenShowFilter(): SQL {
  return ne(podcasts.status, 'active');
}

/**
 * "This episode's show is still active" — a correlated semi-join, replacing
 * `hiddenShowEpisodeFilter`'s id list. See the file-level doc comment.
 */
export function showIsActive(): SQL {
  return exists(
    getDb()
      .select({ one: sql`1` })
      .from(podcasts)
      .where(and(eq(podcasts.id, episodes.podcastId), eq(podcasts.status, 'active')))
  );
}

/**
 * The status gate for episodes of ONE show, from a given viewer's position.
 *
 * Returns `undefined` for the owner — no condition at all, which is what the
 * Mongo `{}` meant. A caller composes it with `and()`, which drops `undefined`
 * arguments, so the two spellings behave identically.
 *
 * Both arguments are nullable and the comparison is deliberately strict: a show
 * with NO owner (`ownerOxyUserId` null, every RSS-mirrored show) must not be
 * owned by an unauthenticated viewer whose id is also absent.
 */
export function episodeVisibilityFilter(
  ownerOxyUserId: string | null | undefined,
  viewerId: string | null | undefined
): SQL | undefined {
  const isOwner = !!viewerId && !!ownerOxyUserId && viewerId === ownerOxyUserId;
  return isOwner ? undefined : eq(episodes.status, 'ready');
}

/**
 * An episode a stranger may be offered in a cross-show listing (search, the
 * "appears in" shelf).
 *
 * `status = 'ready'` AND the show is active AND there is something to play:
 * Syra-hosted episodes stream from our own storage, RSS episodes need an
 * enclosure. The Mongo form tested `{ enclosureUrl: { $exists: true, $nin:
 * [null, ''] } }` — three conditions because a Mongo field can be absent, null,
 * or empty. A Postgres column is only null or a value, so `is not null` plus
 * `<> ''` is the whole of it.
 */
export function publiclyPlayableEpisodeFilter(): SQL {
  return and(
    eq(episodes.status, 'ready'),
    showIsActive(),
    or(
      eq(episodes.source, 'syra'),
      and(isNotNull(episodes.enclosureUrl), ne(episodes.enclosureUrl, ''))
    )
  ) as SQL;
}
