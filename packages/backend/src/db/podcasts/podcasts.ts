/**
 * Shows — every read and write of `podcasts` and its four child tables.
 *
 * The write side is the part that changed shape. Under Mongo a show and its
 * categories, funding links, credits and provenance were ONE document, so
 * `findOneAndUpdate` was atomic over all of them for free. Here they are five
 * tables, so every write that touches a child runs in a TRANSACTION — otherwise
 * a crawl that failed between the row update and the credit replace would leave
 * a show carrying the previous refresh's hosts, with nothing to say so.
 *
 * ## `$set` / `$setOnInsert` becomes an explicit branch, not `onConflictDoUpdate`
 *
 * `importFeed` looked the show up by `feedUrl`, falling back to `podcastGuid`
 * when a feed moved, and then upserted on whichever it found. That cannot be one
 * `ON CONFLICT` clause: the conflict TARGET differs between the two cases, and
 * `podcasts` has a separate unique constraint for each. So the branch is
 * written out — update by id when the caller already resolved the row, insert
 * otherwise — and the insert still carries `onConflictDoUpdate` on `feed_url`,
 * because two crawls of the same feed can interleave between the lookup and the
 * write. That race existed under Mongo too and was resolved by the same
 * mechanism (a unique index); this just has to name it.
 *
 * ## Ordering is `descNullsLast` throughout, and it is BOTH correctness and speed
 *
 * Postgres `DESC` is `NULLS FIRST`, the inversion of Mongo, which sorts a
 * missing field lowest. Every ordering here therefore has to be `NULLS LAST` to
 * mean what the Mongo sort meant — and drizzle emits `.desc()` in an INDEX
 * definition as `DESC NULLS LAST`, so it is also the only spelling that can
 * STREAM those indexes. Measured on 4,900 active shows
 * (`__tests__/podcasts.explain.test.ts`), browse-by-recency:
 *
 *   desc nulls last   Index Scan, stops at 20                  cost   3.13
 *   desc              Index Scan of all 4,900 + top-N heapsort cost 828.26
 *
 * Both reach the index; only the correct spelling costs the PAGE rather than the
 * whole result set, so the wrong one degrades as the catalogue grows instead of
 * being visibly wrong at any one size. The faithful ordering and the fast one
 * are the same ordering.
 */

import { and, asc, count, eq, exists, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { PodcastFunding, PodcastPerson, PodcastSourceProvenance } from '@syra/shared-types';
import { getDb, type DbOrTransaction } from '../postgres';
import { genres } from '../schema/genres';
import { podcastCategories, podcasts } from '../schema/podcasts';
import { descNullsLast } from '../catalog/containers';
import { textSearch } from '../catalog/search';
import {
  setPodcastCategories,
  setPodcastFunding,
  setPodcastPersons,
  setPodcastSources,
} from './children';
import { podcastCreditsPerson, type CreditIdentity } from './persons';
import { activeShowFilter, hiddenShowFilter } from './visibility';
import type { PodcastRow } from './serialize';

/** The columns a caller may write on `podcasts`. */
export type PodcastValues = Partial<Omit<typeof podcasts.$inferInsert, 'id' | 'searchVector'>>;

/**
 * The child collections a write may replace.
 *
 * Every field is optional and `undefined` means LEAVE ALONE, matching the
 * `definedOnly` filter the Mongo `$set` builders used: a feed that carries no
 * `<podcast:funding>` tag must not erase funding links a creator added, which is
 * a different thing from a feed that carries an empty list.
 */
export interface PodcastChildValues {
  readonly categories?: readonly string[];
  readonly funding?: readonly PodcastFunding[];
  readonly persons?: readonly PodcastPerson[];
  readonly sources?: readonly PodcastSourceProvenance[];
}

/** Apply whichever child collections the caller supplied, inside its transaction. */
async function writeChildren(
  tx: DbOrTransaction,
  podcastId: string,
  children: PodcastChildValues
): Promise<void> {
  if (children.categories !== undefined) {
    await setPodcastCategories(tx, podcastId, children.categories);
  }
  if (children.funding !== undefined) await setPodcastFunding(tx, podcastId, children.funding);
  if (children.persons !== undefined) await setPodcastPersons(tx, podcastId, children.persons);
  if (children.sources !== undefined) await setPodcastSources(tx, podcastId, children.sources);
}

/**
 * Drop `undefined` values so a partial write never clobbers a stored column with
 * null — the `definedOnly` helper the two Mongo `$set` builders each had a copy
 * of. Drizzle would omit an `undefined` key anyway; this exists so an
 * all-undefined object is visibly EMPTY here rather than reaching drizzle as a
 * `set` with no columns, which throws.
 */
function definedOnly<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

// ── Reads ─────────────────────────────────────────────────────────────────

export async function findPodcastById(id: string): Promise<PodcastRow | undefined> {
  const [row] = await getDb().select().from(podcasts).where(eq(podcasts.id, id)).limit(1);
  return row;
}

export async function findPodcastByFeedUrl(feedUrl: string): Promise<PodcastRow | undefined> {
  const [row] = await getDb().select().from(podcasts).where(eq(podcasts.feedUrl, feedUrl)).limit(1);
  return row;
}

export async function findPodcastByGuid(podcastGuid: string): Promise<PodcastRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(podcasts)
    .where(eq(podcasts.podcastGuid, podcastGuid))
    .limit(1);
  return row;
}

/** Shows by id, in no particular order — the subscription list's hydration read. */
export async function findPodcastsByIds(ids: readonly string[]): Promise<PodcastRow[]> {
  if (ids.length === 0) return [];
  return getDb().select().from(podcasts).where(inArray(podcasts.id, [...ids]));
}

/** A creator's own shows, newest first. Every status — this is their dashboard. */
export async function findPodcastsByOwner(ownerOxyUserId: string): Promise<PodcastRow[]> {
  return getDb()
    .select()
    .from(podcasts)
    .where(eq(podcasts.ownerOxyUserId, ownerOxyUserId))
    .orderBy(descNullsLast(podcasts.createdAt));
}

export type BrowseSort = 'popular' | 'recent';

export interface BrowseOptions {
  readonly category?: string;
  readonly sort?: BrowseSort;
  readonly offset: number;
  readonly limit: number;
}

/**
 * `GET /api/podcasts` — the browse shelf.
 *
 * The category filter resolves the NAME to a genre id first and then tests
 * membership, rather than joining `genres` inside the `EXISTS`. Two indexed
 * lookups (`genres_lower_name_kind_key`, then
 * `podcast_categories_podcast_id_genre_id_key`) instead of one probe that has to
 * evaluate `lower(g.name)` per candidate show.
 *
 * The comparison is case-INSENSITIVE, which the Mongo array-contains was not.
 * That is a deliberate correction, not drift: `genres` dedups on
 * `(lower(name), kind)` and keeps the first spelling it saw, so the stored name
 * may differ in case from anything a client sends, and an exact match would
 * return an empty shelf for a category that plainly exists.
 */
export async function browsePodcastRows(options: BrowseOptions): Promise<PodcastRow[]> {
  const conditions: SQL[] = [activeShowFilter()];

  if (options.category) {
    const [genre] = await getDb()
      .select({ id: genres.id })
      .from(genres)
      .where(and(sql`lower(${genres.name}) = lower(${options.category})`, eq(genres.kind, 'podcast')))
      .limit(1);

    // A category nobody has ever been filed under matches no show. Returning
    // early rather than composing an `EXISTS` against a null id keeps that an
    // empty page instead of a query that cannot be satisfied.
    if (!genre) return [];
    conditions.push(hasCategory(genre.id));
  }

  const orderBy =
    options.sort === 'recent'
      ? [descNullsLast(podcasts.lastEpisodeAt)]
      : [descNullsLast(podcasts.popularity), descNullsLast(podcasts.subscriberCount)];

  return getDb()
    .select()
    .from(podcasts)
    .where(and(...conditions))
    .orderBy(...orderBy)
    .offset(options.offset)
    .limit(options.limit);
}

/** "This show is filed under that genre", as a correlated `EXISTS`. */
function hasCategory(genreId: string): SQL {
  return exists(
    getDb()
      .select({ one: sql`1` })
      .from(podcastCategories)
      .where(
        and(
          eq(podcastCategories.podcastId, podcasts.id),
          eq(podcastCategories.genreId, genreId)
        )
      )
  );
}

/**
 * The three-key ordering both search surfaces use — `searchPodcasts` in
 * `podcasts.controller` and the podcasts category of `/api/search`. Written once
 * because the two disagreeing would show up as a shelf that reorders when a user
 * moves between them, and `podcasts_active_popularity_idx` serves exactly this
 * sequence.
 */
const SEARCH_ORDER = [
  descNullsLast(podcasts.popularity),
  descNullsLast(podcasts.subscriberCount),
  descNullsLast(podcasts.lastEpisodeAt),
];

/**
 * Active shows matching a query, through the GIN-indexed `search_vector`.
 *
 * This replaces a case-insensitive regex over `title` and `author` — the last
 * podcast regex, and the reason `escapeRegex` survived in two files. The
 * generated column is `to_tsvector('english', title || ' ' || coalesce(author,
 * ''))`, so the Mongo `$or` over two fields is ONE match here and the
 * `coalesce` is what stops a null author erasing the whole vector.
 *
 * Same ruling and same accepted loss as the catalogue (`db/catalog/search.ts`):
 * word and prefix matching, stemming gained, infix lost.
 */
export async function searchPodcastRows(
  query: string,
  offset: number,
  limit: number
): Promise<PodcastRow[]> {
  return getDb()
    .select()
    .from(podcasts)
    .where(and(activeShowFilter(), textSearch(podcasts.searchVector, query)))
    .orderBy(...SEARCH_ORDER)
    .offset(offset)
    .limit(limit);
}

export async function countSearchPodcasts(query: string): Promise<number> {
  const [row] = await getDb()
    .select({ total: count() })
    .from(podcasts)
    .where(and(activeShowFilter(), textSearch(podcasts.searchVector, query)));
  return row?.total ?? 0;
}

/**
 * Shows crediting a person — the `appearsIn` shelf's show half.
 *
 * `status <> 'removed'` rather than `= 'active'`: a person's profile keeps
 * listing a show its creator has merely unpublished, which is what the Mongo
 * filter said. Only a platform takedown removes it.
 */
export async function findPodcastsCreditingPerson(
  person: CreditIdentity,
  limit: number
): Promise<PodcastRow[]> {
  return getDb()
    .select()
    .from(podcasts)
    .where(and(podcastCreditsPerson(person), ne(podcasts.status, 'removed')))
    .orderBy(descNullsLast(podcasts.popularity), descNullsLast(podcasts.lastEpisodeAt))
    .limit(limit);
}

/**
 * The refresh scheduler's batch: active RSS feeds, most-subscribed first.
 *
 * Served by `podcasts_rss_active_subscriber_count_idx`, whose partial predicate
 * is this exact pair of conditions.
 */
export async function findRefreshCandidates(limit: number): Promise<
  { feedUrl: string | null; lastRefreshedAt: Date | null; refreshIntervalMin: number }[]
> {
  return getDb()
    .select({
      feedUrl: podcasts.feedUrl,
      lastRefreshedAt: podcasts.lastRefreshedAt,
      refreshIntervalMin: podcasts.refreshIntervalMin,
    })
    .from(podcasts)
    .where(and(eq(podcasts.source, 'rss'), activeShowFilter()))
    .orderBy(descNullsLast(podcasts.subscriberCount), descNullsLast(podcasts.popularity))
    .limit(limit);
}

/**
 * Among a candidate set of feeds, the ones worth a deep import: never imported,
 * or not re-fetched since `staleBefore`.
 *
 * Bounded by `feedUrl IN (…)` against the unique `podcasts_feed_url_key` over a
 * small caller-supplied list, which is why `needs_deep_import` has no index of
 * its own — see `schema/podcasts.ts`.
 */
export async function findDeepImportTargets(
  feedUrls: readonly string[],
  staleBefore: Date
): Promise<string[]> {
  if (feedUrls.length === 0) return [];

  const rows = await getDb()
    .select({ feedUrl: podcasts.feedUrl })
    .from(podcasts)
    .where(
      and(
        inArray(podcasts.feedUrl, [...feedUrls]),
        /**
         * `lt()`, not a raw `sql` fragment interpolating the Date.
         *
         * A value inside a raw `sql` template reaches the driver UNMAPPED —
         * drizzle applies a column's `mapToDriverValue` only when the comparison
         * goes through a typed operator. Interpolating a JS `Date` against a
         * `timestamptz` therefore failed at the wire with `The "string" argument
         * must be of type string … Received an instance of Date`, from inside
         * postgres.js, naming nothing in this file. Same trap as `max()` in
         * `episodes.ts`, in the other direction: there the mapper was skipped on
         * the way OUT, here on the way IN.
         */
        or(
          eq(podcasts.needsDeepImport, true),
          isNull(podcasts.lastRefreshedAt),
          lt(podcasts.lastRefreshedAt, staleBefore)
        )
      )
    );

  return rows.flatMap((row) => (row.feedUrl === null ? [] : [row.feedUrl]));
}

/** Every show id whose status is not `active` — the takedown/unpublish set. */
export async function findHiddenShowIds(): Promise<string[]> {
  const rows = await getDb().select({ id: podcasts.id }).from(podcasts).where(hiddenShowFilter());
  return rows.map((row) => row.id);
}

// ── Writes ────────────────────────────────────────────────────────────────

/** Insert a show and its child collections in one transaction. */
export async function insertPodcast(
  values: typeof podcasts.$inferInsert,
  children: PodcastChildValues = {}
): Promise<PodcastRow> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx.insert(podcasts).values(values).returning();
    if (!row) throw new Error('insertPodcast: insert returned no row');
    await writeChildren(tx, row.id, children);
    return row;
  });
}

/**
 * Update a show and whichever child collections the caller supplied.
 *
 * Returns the updated row, or `undefined` when the id names nothing — the
 * caller's 404, rather than a silent success against zero rows.
 */
export async function updatePodcast(
  id: string,
  values: PodcastValues,
  children: PodcastChildValues = {}
): Promise<PodcastRow | undefined> {
  return getDb().transaction(async (tx) => {
    const set = definedOnly(values);
    let row: PodcastRow | undefined;

    if (Object.keys(set).length > 0) {
      [row] = await tx.update(podcasts).set(set).where(eq(podcasts.id, id)).returning();
    } else {
      [row] = await tx.select().from(podcasts).where(eq(podcasts.id, id)).limit(1);
    }

    if (!row) return undefined;
    await writeChildren(tx, id, children);
    return row;
  });
}

/**
 * The import path's show upsert.
 *
 * `existingId` is what the caller's own `feedUrl` → `podcastGuid` lookup
 * resolved; when it is set this is a plain update, and when it is not this is an
 * insert that still has to survive a concurrent crawl of the same feed —
 * `onConflictDoUpdate` on `feed_url` applies only the `set` half, never the
 * insert-only columns, which is what `$setOnInsert` meant.
 */
export async function upsertPodcastFromFeed(input: {
  readonly existingId: string | undefined;
  /**
   * The COMPLETE row for the insert path, including the insert-only columns
   * (`source`, `status`, `claimable`) that `$setOnInsert` carried.
   *
   * Split from `set` rather than merged with it because `podcasts.title` and
   * `podcasts.source` are `NOT NULL` with no default, and a single `Partial`
   * value object would let an insert missing either type-check. Mongo accepted
   * exactly that: `findOneAndUpdate` upserts do not run validators, so a feed
   * with no `<title>` inserted a title-less show that every DTO then failed to
   * parse.
   */
  readonly insert: typeof podcasts.$inferInsert;
  /** The columns a REFRESH overwrites — a subset of the insert, never a superset. */
  readonly set: PodcastValues;
  readonly children: PodcastChildValues;
}): Promise<PodcastRow> {
  return getDb().transaction(async (tx) => {
    const set = definedOnly(input.set);
    let row: PodcastRow | undefined;

    if (input.existingId) {
      if (Object.keys(set).length > 0) {
        [row] = await tx
          .update(podcasts)
          .set(set)
          .where(eq(podcasts.id, input.existingId))
          .returning();
      } else {
        [row] = await tx.select().from(podcasts).where(eq(podcasts.id, input.existingId)).limit(1);
      }
    } else {
      [row] = await tx
        .insert(podcasts)
        .values(input.insert)
        .onConflictDoUpdate({
          target: podcasts.feedUrl,
          // `set` only. A show that already exists keeps the `source`,
          // `status` and `claimable` it was created with — a refresh must not
          // silently re-open a claimed show or resurrect a takedown.
          set: Object.keys(set).length > 0 ? { ...set, updatedAt: new Date() } : { updatedAt: new Date() },
        })
        .returning();
    }

    if (!row) throw new Error(`upsertPodcastFromFeed: no row for ${input.insert.feedUrl}`);
    await writeChildren(tx, row.id, input.children);
    return row;
  });
}

/** One directory candidate's shallow upsert — see {@link shallowUpsertPodcasts}. */
export interface ShallowCandidate {
  readonly feedUrl: string;
  /** The complete row for the insert path — same split, same reason, as above. */
  readonly insert: typeof podcasts.$inferInsert;
  /** The directory-owned metadata a re-sync refreshes on an existing show. */
  readonly set: PodcastValues;
  readonly categories?: readonly string[];
}

/**
 * The search-time shallow upsert: directory metadata only, no feed fetch.
 *
 * Mongo did this as ONE unordered `bulkWrite`, so a duplicate `podcastGuid` in
 * the batch failed that one operation and let the rest through. There is no
 * batched multi-row upsert with per-row `$setOnInsert` semantics here, so this
 * is a loop — and the loop is per-candidate ISOLATED for the same reason
 * `ordered: false` was chosen: one bad candidate out of twenty-five must not
 * cost the other twenty-four their instant search results.
 *
 * Returns how many rows were actually written, so the caller logs a measurement
 * rather than the candidate count it already had.
 */
export async function shallowUpsertPodcasts(
  candidates: readonly ShallowCandidate[],
  onError: (feedUrl: string, error: unknown) => void
): Promise<number> {
  let written = 0;

  for (const candidate of candidates) {
    try {
      const set = definedOnly(candidate.set);
      const row = await getDb().transaction(async (tx) => {
        const [upserted] = await tx
          .insert(podcasts)
          .values(candidate.insert)
          .onConflictDoUpdate({
            target: podcasts.feedUrl,
            set: { ...set, updatedAt: new Date() },
          })
          .returning({ id: podcasts.id });

        if (upserted && candidate.categories !== undefined) {
          await setPodcastCategories(tx, upserted.id, candidate.categories);
        }
        return upserted;
      });

      if (row) written += 1;
    } catch (error) {
      onError(candidate.feedUrl, error);
    }
  }

  return written;
}

/**
 * The per-show counters the import path recomputes at the end of a crawl.
 *
 * Separate from {@link updatePodcast} because it takes no children and must be
 * callable on a row the caller already holds, without re-reading it.
 */
export async function setPodcastRefreshState(
  id: string,
  values: Pick<
    PodcastValues,
    'episodeCount' | 'lastEpisodeAt' | 'lastRefreshedAt' | 'needsDeepImport' | 'etag' | 'lastModified'
  >
): Promise<void> {
  const set = definedOnly(values);
  if (Object.keys(set).length === 0) return;
  await getDb().update(podcasts).set(set).where(eq(podcasts.id, id));
}

/** Bump a show's episode counters after an episode lands. */
export async function recordNewEpisode(id: string, pubDate: Date): Promise<void> {
  await getDb()
    .update(podcasts)
    .set({
      episodeCount: sql`${podcasts.episodeCount} + 1`,
      lastEpisodeAt: pubDate,
    })
    .where(eq(podcasts.id, id));
}

/** The category names of one show, in the feed's own order — the single-show read. */
export async function podcastCategoryNames(podcastId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ name: genres.name })
    .from(podcastCategories)
    .innerJoin(genres, eq(genres.id, podcastCategories.genreId))
    .where(eq(podcastCategories.podcastId, podcastId))
    .orderBy(asc(podcastCategories.position));

  return rows.map((row) => row.name);
}
