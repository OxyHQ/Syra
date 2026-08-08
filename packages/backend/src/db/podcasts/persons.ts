/**
 * "Which shows and episodes credit this person" — the `appears in` predicate,
 * on drizzle.
 *
 * This is Task 10b's deferral, and the deferral was a SCOPE boundary, never a
 * capability one: `podcast_persons` and `episode_persons` have existed since
 * Task 4, so expressing `strongKeyCreditMatch` here was always possible; doing
 * it meant writing podcast reads, which belonged to this task.
 *
 * ## Three tiers, and why the order is not negotiable
 *
 * `services/podcasts/resolvePersons.ts` DEDUPS credits by strong key —
 * `linkedOxyUserId`, else `href`, else a name key among name-only credits. This
 * predicate has to select by the SAME keys in the SAME order, or the "appears
 * in" shelf disagrees with the resolver about which credits are the same person:
 *
 *   1. `linkedOxyUserId` — an Oxy account. Canonical.
 *   2. `href` — a stable URL identity from the feed.
 *   3. exact name, case-insensitively — the low-confidence tier, and the only
 *      one that can collide between two different people of the same name. It
 *      fires only when the person row carries neither strong key, which is
 *      exactly the case where the resolver would also have merged them.
 *
 * ## `$elemMatch` over an embedded array becomes a correlated `EXISTS`
 *
 * The Mongo form was `{ persons: { $elemMatch: { linkedOxyUserId } } }` — one
 * condition usable against BOTH collections, because both embedded the same
 * sub-schema. Two tables cannot share one condition, so there are two functions.
 * They are spelled out rather than parameterised over a table: the alternative
 * is selecting through an un-narrowed `PgColumn`, which is the untyped seam this
 * port has already been burned by.
 *
 * Tiers 1 and 2 land on `podcast_persons_linked_oxy_user_id_idx` /
 * `podcast_persons_href_idx` (and their episode twins), which `schema/
 * podcasts.ts` built for this query by name. Tier 3 has NO index — `name` is
 * unindexed on both credit tables, exactly as it was unindexed inside the Mongo
 * array — so it is a scan of the credit table, hashed and semi-joined rather
 * than probed. That is parity, not a regression, and it is the tier that fires
 * least.
 */

import { and, eq, exists, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { getDb } from '../postgres';
import { episodePersons, episodes, podcastPersons, podcasts } from '../schema/podcasts';

/**
 * The keys a credit match is made on.
 *
 * Deliberately smaller than `PersonLike`: this module needs three fields, and
 * naming only those keeps `db/` from importing a type out of `services/` (the
 * wrong direction) purely to read a subset of it.
 */
export interface CreditIdentity {
  readonly name: string;
  readonly href?: string;
  readonly linkedOxyUserId?: string;
}

/**
 * WHICH key this person is matched on — decided once, applied twice.
 *
 * The tier ORDER is the thing that has to agree with the resolver, and it lives
 * here. The COLUMNS cannot: drizzle brands every column with its table name, so
 * `podcastPersons.href` is not assignable where `episodePersons.href` is
 * expected, and a helper taking both would have to select through an
 * un-narrowed `PgColumn` — the untyped seam that let a drizzle row reach
 * `formatTracksWithCoverArt(tracks: any[])` and answer `{"id":""}`. Returning a
 * DESCRIPTOR and letting each caller apply it to its own columns keeps the
 * shared thing shared and every column fully typed.
 */
type CreditTier =
  | { readonly key: 'linkedOxyUserId'; readonly value: string }
  | { readonly key: 'href'; readonly value: string }
  | { readonly key: 'name'; readonly value: string };

function creditTier(person: CreditIdentity): CreditTier {
  if (person.linkedOxyUserId) return { key: 'linkedOxyUserId', value: person.linkedOxyUserId };
  if (person.href) return { key: 'href', value: person.href };
  return { key: 'name', value: person.name };
}

/**
 * `lower(a) = lower(b)`, not the Mongo `new RegExp('^' + escaped + '$', 'i')`.
 *
 * The regex form needed escaping because an unescaped person name reaching a
 * regex engine is a ReDoS on a public endpoint; a parameterised comparison has
 * no such surface, so the escape helper does not come across. The MATCH is the
 * same one — anchored at both ends, case-insensitive — because `=` on a whole
 * column is already anchored.
 */
function nameMatches(column: PgColumn, value: string): SQL {
  return sql`lower(${column}) = lower(${value})`;
}

/** Shows whose channel-level credits name this person. */
export function podcastCreditsPerson(person: CreditIdentity): SQL {
  const tier = creditTier(person);
  const match =
    tier.key === 'linkedOxyUserId'
      ? eq(podcastPersons.linkedOxyUserId, tier.value)
      : tier.key === 'href'
        ? eq(podcastPersons.href, tier.value)
        : nameMatches(podcastPersons.name, tier.value);

  return exists(
    getDb()
      .select({ one: sql`1` })
      .from(podcastPersons)
      .where(and(eq(podcastPersons.podcastId, podcasts.id), match))
  );
}

/** Episodes whose per-episode credits name this person. */
export function episodeCreditsPerson(person: CreditIdentity): SQL {
  const tier = creditTier(person);
  const match =
    tier.key === 'linkedOxyUserId'
      ? eq(episodePersons.linkedOxyUserId, tier.value)
      : tier.key === 'href'
        ? eq(episodePersons.href, tier.value)
        : nameMatches(episodePersons.name, tier.value);

  return exists(
    getDb()
      .select({ one: sql`1` })
      .from(episodePersons)
      .where(and(eq(episodePersons.episodeId, episodes.id), match))
  );
}
