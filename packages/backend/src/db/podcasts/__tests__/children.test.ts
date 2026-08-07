/**
 * The podcast category junction — the composite-FK path, gated.
 *
 * The Task 12 review (I1) found this path had ZERO tests: every fixture in the
 * import suites passes `categories: []`, so `setPodcastCategories` returned
 * before inserting and the `23503` the brief names as its second cross-vertical
 * risk was never exercised. The reviewer probed the behaviour by hand and found
 * it correct — which is exactly the state worth gating, because "correct today
 * and unguarded tomorrow" is what this branch keeps converting into defects.
 *
 * ## What the composite FK is for, and why a shared resolver would defeat it
 *
 * `genres` serves two verticals. Uniqueness is per `kind`, so "Comedy" the
 * podcast category and "Comedy" the music genre are two rows, and
 * `podcast_categories` carries `(genre_id, kind) -> genres(id, kind)` with
 * `ON DELETE RESTRICT` so a podcast cannot be filed under a MUSIC genre even if
 * somebody hands it that id. Every case below tests one half of that: the
 * resolver asking the right question, and the constraint refusing the wrong
 * answer.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { and, asc, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../postgres';
import { genres } from '../../schema/genres';
import { podcastCategories, podcasts } from '../../schema/podcasts';
import { resolvePodcastCategoryIds, setPodcastCategories } from '../children';
import { loadPodcastCategories } from '../hydrate';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

/** A show to hang categories on — `podcast_id` is a real foreign key. */
async function makeShow(): Promise<string> {
  const id = uuidv7();
  await getDb().insert(podcasts).values({ id, title: 'A Show', source: 'rss' });
  return id;
}

/** Every `genres` row of one kind, by name. */
async function genreNames(kind: 'music' | 'podcast'): Promise<string[]> {
  const rows = await getDb()
    .select({ name: genres.name })
    .from(genres)
    .where(eq(genres.kind, kind))
    .orderBy(asc(genres.name));
  return rows.map((row) => row.name);
}

/** The junction rows of one show, in stored order. */
async function storedCategories(podcastId: string): Promise<{ name: string; position: number }[]> {
  return getDb()
    .select({ name: genres.name, position: podcastCategories.position })
    .from(podcastCategories)
    .innerJoin(genres, eq(genres.id, podcastCategories.genreId))
    .where(eq(podcastCategories.podcastId, podcastId))
    .orderBy(asc(podcastCategories.position));
}

describe('resolvePodcastCategoryIds — scoped to kind = podcast', () => {
  it('creates podcast genres and does NOT reuse a music genre of the same name', async () => {
    /**
     * The fixture that separates the scoped resolver from an unscoped one.
     *
     * A pre-existing MUSIC "Comedy" is the whole test: an unscoped resolver
     * returns its id, the composite FK then refuses the insert, and the failure
     * surfaces as a `23503` from the import path rather than as anything
     * naming the resolver. Without a music row of the same name, a resolver
     * that ignored `kind` entirely would pass.
     */
    await getDb().insert(genres).values({ name: 'Comedy', kind: 'music' });

    const ids = await resolvePodcastCategoryIds(getDb(), ['Comedy']);
    expect(ids).toHaveLength(1);

    const [row] = await getDb()
      .select({ kind: genres.kind })
      .from(genres)
      .where(eq(genres.id, ids[0] ?? ''));
    expect(row?.kind).toBe('podcast');

    // Two rows now, one per kind — the vocabularies do not bleed.
    expect(await genreNames('music')).toEqual(['Comedy']);
    expect(await genreNames('podcast')).toEqual(['Comedy']);
  });

  it('dedups case-insensitively across calls, keeping the first spelling', async () => {
    const first = await resolvePodcastCategoryIds(getDb(), ['True Crime']);
    const second = await resolvePodcastCategoryIds(getDb(), ['true crime']);

    // `genres_lower_name_kind_key` is a unique index on `(lower(name), kind)`,
    // so the second call must find the first row rather than create a second.
    expect(second).toEqual(first);
    expect(await genreNames('podcast')).toEqual(['True Crime']);
  });

  it('dedups WITHIN one call and drops blanks', async () => {
    const ids = await resolvePodcastCategoryIds(getDb(), ['News', ' news ', '', '   ', 'News']);

    expect(ids).toHaveLength(1);
    expect(await genreNames('podcast')).toEqual(['News']);
  });

  it('returns ids in the CALLER\'s order, not the planner\'s', async () => {
    /**
     * The defect this function was fixed for, gated at its own level rather
     * than only through the import path. The names are deliberately not in
     * alphabetical order: a `select … where lower(name) in (…)` returns rows in
     * the planner's order, so an alphabetical fixture cannot tell a
     * re-sequenced result from a raw one.
     */
    const wanted = ['News', 'Daily News', 'Business'];
    const ids = await resolvePodcastCategoryIds(getDb(), wanted);

    const rows = await getDb().select({ id: genres.id, name: genres.name }).from(genres);
    const nameById = new Map(rows.map((row) => [row.id, row.name]));

    expect(ids.map((id) => nameById.get(id))).toEqual(wanted);
  });
});

describe('setPodcastCategories', () => {
  it('links a show to its categories, positioned in feed order', async () => {
    const showId = await makeShow();
    await setPodcastCategories(getDb(), showId, ['News', 'Daily News', 'Business']);

    expect(await storedCategories(showId)).toEqual([
      { name: 'News', position: 0 },
      { name: 'Daily News', position: 1 },
      { name: 'Business', position: 2 },
    ]);
  });

  it('REPLACES rather than appends, so a re-crawl cannot collide on position', async () => {
    const showId = await makeShow();
    await setPodcastCategories(getDb(), showId, ['News', 'Business']);
    // `unique(podcast_id, position)` makes a naive append throw rather than
    // duplicate, so this is the assertion that the delete-then-insert is real.
    await setPodcastCategories(getDb(), showId, ['Business', 'Comedy', 'News']);

    expect(await storedCategories(showId)).toEqual([
      { name: 'Business', position: 0 },
      { name: 'Comedy', position: 1 },
      { name: 'News', position: 2 },
    ]);
  });

  it('an empty list clears the links and creates no genres', async () => {
    const showId = await makeShow();
    await setPodcastCategories(getDb(), showId, ['News']);
    await setPodcastCategories(getDb(), showId, []);

    expect(await storedCategories(showId)).toEqual([]);
    // The `News` genre row survives — it is global vocabulary, not this show's.
    expect(await genreNames('podcast')).toEqual(['News']);
  });

  it('two shows can share a category', async () => {
    const first = await makeShow();
    const second = await makeShow();
    await setPodcastCategories(getDb(), first, ['News']);
    await setPodcastCategories(getDb(), second, ['News']);

    expect((await loadPodcastCategories([first, second])).get(first)).toEqual(['News']);
    expect((await loadPodcastCategories([first, second])).get(second)).toEqual(['News']);
    expect(await genreNames('podcast')).toEqual(['News']);
  });
});

describe('the composite foreign key', () => {
  it('REFUSES a music genre id, which is the whole reason it is composite', async () => {
    const showId = await makeShow();
    const [musicGenre] = await getDb()
      .insert(genres)
      .values({ name: 'Jazz', kind: 'music' })
      .returning({ id: genres.id });

    /**
     * A single-column FK on `genre_id` alone could not stop this row: the
     * genre EXISTS, it is simply the wrong kind. `(genre_id, kind) ->
     * genres(id, kind)` plus `CHECK kind = 'podcast'` on this table is what
     * makes it unrepresentable, and this is the assertion that says so rather
     * than the schema comment claiming it.
     */
    await expect(
      Promise.resolve(
        getDb()
          .insert(podcastCategories)
          .values({ podcastId: showId, genreId: musicGenre?.id ?? '', position: 0, kind: 'podcast' })
      )
    ).rejects.toThrow();

    expect(await storedCategories(showId)).toEqual([]);
  });

  it('RESTRICTS deleting a genre a show is still filed under', async () => {
    const showId = await makeShow();
    await setPodcastCategories(getDb(), showId, ['News']);

    const [genre] = await getDb()
      .select({ id: genres.id })
      .from(genres)
      .where(and(eq(genres.name, 'News'), eq(genres.kind, 'podcast')));

    await expect(
      Promise.resolve(getDb().delete(genres).where(eq(genres.id, genre?.id ?? '')))
    ).rejects.toThrow();
  });

  it('CASCADES when the show itself is deleted', async () => {
    const showId = await makeShow();
    await setPodcastCategories(getDb(), showId, ['News']);

    await getDb().delete(podcasts).where(eq(podcasts.id, showId));

    expect(await storedCategories(showId)).toEqual([]);
    // The vocabulary survives the show — `RESTRICT` on the genre side and
    // `CASCADE` on the podcast side are different rules, and this is the one
    // that distinguishes them.
    expect(await genreNames('podcast')).toEqual(['News']);
  });
});
