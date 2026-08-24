/**
 * Who may see which show and which episode — the podcast vertical's predicates,
 * in one place, the way `db/catalog/visibility.ts` holds the catalogue's.
 *
 * ## Two axes, and they are not interchangeable
 *
 * `podcasts.status` says WHETHER a show is published (a creator unpublish, a
 * platform takedown); `podcasts.visibility` says WHO may see it (`private`,
 * `unlisted`, `public`). Every rule below is one of three combinations of the
 * two, and each has a name so no call site has to re-derive it:
 *
 *  - LISTABLE  — active AND public. Browse, search, every discovery shelf.
 *  - REACHABLE — active AND not private. A direct link by id: `unlisted` is
 *    reachable, which is the whole point of `unlisted`.
 *  - OWNED     — the show's `ownerOxyUserId`. The owner sees their own show in
 *    every state, which is what makes a private show usable at all.
 *
 * ## Two SPELLINGS of each rule, and picking the wrong one is silent
 *
 * A query whose `FROM` is `podcasts` states the rule as a plain column
 * comparison ({@link listableShowFilter} and friends). A query whose `FROM` is
 * `episodes` states the SAME rule as a correlated `EXISTS` against the parent
 * show ({@link showIsListable} and friends). They are separate functions rather
 * than one, because the correlated form is unusable on `podcasts` itself: the
 * inner `podcasts` reference would shadow the outer one, so
 * `exists (select 1 from podcasts where podcasts.id = podcasts.id and …)` is
 * TRUE for every row as soon as any listable show exists anywhere. That is a
 * hole a test over one fixture show cannot see, which is why the two families
 * are named differently instead of being one function used in two places.
 *
 * The existing pair `activeShowFilter`/`showIsActive` was already this split;
 * this file just makes the rule explicit rather than incidental.
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

// ── Ownership ─────────────────────────────────────────────────────────────

/**
 * Whether `viewerId` owns `show`.
 *
 * Both sides are nullable and the comparison is deliberately strict: a show with
 * NO owner (`ownerOxyUserId` null — every RSS-mirrored show) must not come out
 * owned by an unauthenticated viewer whose id is also absent.
 */
export function viewerOwnsShow(
  show: { readonly ownerOxyUserId: string | null },
  viewerId: string | null | undefined
): boolean {
  return !!viewerId && show.ownerOxyUserId !== null && show.ownerOxyUserId === viewerId;
}

/** The SQL half of {@link viewerOwnsShow}, on `podcasts`. */
function showOwnedBy(viewerId: string | null | undefined): SQL | undefined {
  return viewerId ? eq(podcasts.ownerOxyUserId, viewerId) : undefined;
}

/**
 * The in-memory twin of {@link viewerCanReadShowFilter} — REACHABLE, or theirs.
 *
 * Two spellings of one rule, and they are kept in this file side by side for the
 * reason `db/catalog/visibility.ts` states about `isPlayableTrack` and
 * `playableTrackFilter`: a handler that already holds the show row (every caller
 * of `findEpisodeById`, which joins it) must not have to re-query to ask the
 * question, and the two must never be able to disagree. Change them together.
 */
export function viewerCanReadShow(
  show: { readonly status: string; readonly visibility: string; readonly ownerOxyUserId: string | null },
  viewerId: string | null | undefined
): boolean {
  if (viewerOwnsShow(show, viewerId)) return true;
  return show.status === 'active' && show.visibility !== 'private';
}

// ── Rules stated on `podcasts` (a query whose FROM is `podcasts`) ─────────

/** Published — the publish axis alone, with no audience test. */
export function activeShowFilter(): SQL {
  return eq(podcasts.status, 'active');
}

/**
 * A show hidden from discovery by its STATUS — the negation
 * {@link activeShowFilter} does not cover, and the one `podcasts_inactive_idx`
 * exists for. Says nothing about `visibility`.
 */
export function hiddenShowFilter(): SQL {
  return ne(podcasts.status, 'active');
}

/** Audience `public` — the audience axis alone, with no publish test. */
export function publicShowFilter(): SQL {
  return eq(podcasts.visibility, 'public');
}

/** LISTABLE: browse, search, every discovery shelf. */
export function listableShowFilter(): SQL {
  return and(activeShowFilter(), publicShowFilter()) as SQL;
}

/** REACHABLE: a direct read by id, where `unlisted` still resolves. */
export function reachableShowFilter(): SQL {
  return and(activeShowFilter(), ne(podcasts.visibility, 'private')) as SQL;
}

/**
 * What ONE viewer may read by id: reachable, or their own in any state.
 *
 * The owner arm is what keeps a creator's private and unpublished shows working
 * for the creator — without it "make it private" would lock the owner out of
 * their own show's page.
 */
export function viewerCanReadShowFilter(viewerId: string | null | undefined): SQL {
  const owned = showOwnedBy(viewerId);
  return (owned ? or(reachableShowFilter(), owned) : reachableShowFilter()) as SQL;
}

// ── The same rules stated on `episodes` (correlated on the parent show) ───

/** Correlate a condition on `podcasts` to `episodes.podcast_id`. */
function showOfEpisode(condition: SQL): SQL {
  return exists(
    getDb()
      .select({ one: sql`1` })
      .from(podcasts)
      .where(and(eq(podcasts.id, episodes.podcastId), condition))
  );
}

/**
 * "This episode's show is still active" — a correlated semi-join, replacing
 * `hiddenShowEpisodeFilter`'s id list. See the file-level doc comment.
 */
export function showIsActive(): SQL {
  return showOfEpisode(activeShowFilter());
}

/** "This episode's show is LISTABLE" — the cross-show discovery gate. */
export function showIsListable(): SQL {
  return showOfEpisode(listableShowFilter());
}

/**
 * "This episode's show is readable BY THIS VIEWER" — reachable, or theirs.
 *
 * The episode-side twin of {@link viewerCanReadShowFilter}, for the reads keyed
 * on episode ids rather than on a show (`findEpisodesByIds`, the resume list).
 */
export function showIsReadableByViewer(viewerId: string | null | undefined): SQL {
  return showOfEpisode(viewerCanReadShowFilter(viewerId));
}

// ── Episode status ────────────────────────────────────────────────────────

/**
 * The status gate for episodes of ONE show, from a given viewer's position.
 *
 * Returns `undefined` for the owner — no condition at all, which is what the
 * Mongo `{}` meant. A caller composes it with `and()`, which drops `undefined`
 * arguments, so the two spellings behave identically.
 *
 * Both arguments are nullable and the comparison is deliberately strict, for the
 * reason {@link viewerOwnsShow} states.
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
 * `status = 'ready'` AND the show is LISTABLE AND there is something to play:
 * Syra-hosted episodes stream from our own storage, RSS episodes need an
 * enclosure. The Mongo form tested `{ enclosureUrl: { $exists: true, $nin:
 * [null, ''] } }` — three conditions because a Mongo field can be absent, null,
 * or empty. A Postgres column is only null or a value, so `is not null` plus
 * `<> ''` is the whole of it.
 *
 * Listable, not merely active: an `unlisted` show is reachable by id and must
 * still never appear in a listing nobody asked it for by name.
 */
export function publiclyPlayableEpisodeFilter(): SQL {
  return and(
    eq(episodes.status, 'ready'),
    showIsListable(),
    or(
      eq(episodes.source, 'syra'),
      and(isNotNull(episodes.enclosureUrl), ne(episodes.enclosureUrl, ''))
    )
  ) as SQL;
}
