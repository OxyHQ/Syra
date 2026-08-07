/**
 * The seven child collections of a show or an episode, on the write side.
 *
 * `schema/podcasts.ts` turned six Mongo subdocument ARRAYS and one string array
 * into real tables. On the read side that is `hydrate.ts`; here it is the thing
 * a Mongo `$set: { persons: [...] }` used to do in one atomic field assignment
 * and that now takes a delete plus an insert per collection.
 *
 * ## Replace, never append — and the ordinal is what makes replace correct
 *
 * Every one of these is written by a REFRESH (`importFeed` re-parses the whole
 * feed on every crawl) or by a creator edit, and both mean "these are now the
 * credits", not "add these credits". Appending would accumulate a second copy
 * on the second crawl; `unique(parent_id, position)` would refuse the write
 * rather than corrupt the read, but the write is the one that has to succeed.
 *
 * `position` carries the array index, because a Mongo array is ordered and a
 * table is not. It is assigned from the input order here rather than by the
 * caller, so there is exactly one place that decides what "the third host"
 * means.
 *
 * ## Every function takes a `DbOrTransaction`
 *
 * A show's row and its four child collections are ONE logical write. Taking the
 * handle as a parameter is what lets `podcasts.ts` run all five inside a
 * transaction — calling `getDb()` internally would silently execute outside it
 * and survive a rollback, which is the failure `DbOrTransaction` exists to make
 * unrepresentable.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  EpisodePerson,
  EpisodeTranscript,
  HlsRendition,
  PodcastFunding,
  PodcastSourceProvenance,
} from '@syra/shared-types';
import type { DbOrTransaction } from '../postgres';
import { genres } from '../schema/genres';
import {
  episodeHlsRenditions,
  episodePersons,
  episodeTranscripts,
  podcastCategories,
  podcastFunding,
  podcastPersons,
  podcastSources,
} from '../schema/podcasts';

/**
 * Resolve podcast CATEGORY names to `genres.id`s, creating any that do not exist.
 *
 * The `kind = 'podcast'` twin of `db/catalog/genres.ts`'s
 * `resolveMusicGenreIds`, and it has to be a twin rather than a shared helper
 * with a `kind` parameter for the reason that module's own doc comment gives:
 * uniqueness in `genres` is per kind, so "Comedy" the podcast category and
 * "Comedy" the music genre are two rows. A function that took the kind as an
 * argument would read as though the two vocabularies were interchangeable, and
 * `podcast_categories`' composite FK `(genre_id, kind) -> genres(id, kind)`
 * exists precisely because they are not — it would refuse a music row here.
 *
 * The normalisation (trim, drop blanks, case-insensitive dedup keeping the first
 * spelling) matches `resolveMusicGenreIds` exactly, and matters for the same
 * reason: `genres_lower_name_kind_key` is a unique index on `(lower(name),
 * kind)`, so an exact-name read-back would miss a stored `"Comedy"` when asked
 * for `"comedy"` and create a duplicate.
 *
 * ## The result is in the CALLER'S order, and that is not free
 *
 * `setPodcastCategories` turns the index of an id in this result into
 * `podcast_categories.position`, which is the feed's primary-category-first
 * ordering. A `select … where lower(name) in (…)` returns rows in whatever
 * order the planner produces — NOT the order of the `IN` list — so the ids have
 * to be re-sequenced against `wanted` before they can carry an ordinal.
 *
 * This was a real defect, not a hypothetical: the first version of this
 * function returned `rows.map(row => row.id)` under a comment in
 * `setPodcastCategories` asserting the order was preserved. Measured on a real
 * database, `['News', 'Daily News', 'Business']` came back stored as
 * `[0 Business, 1 Daily News, 2 News]` — alphabetical, which is exactly the
 * ordering `position` was added to stop the reader falling back to. The comment
 * was the only thing claiming otherwise, and a comment is not a guard.
 *
 * `db/catalog/genres.ts`'s `resolveMusicGenreIds` has the same property and is
 * deliberately NOT changed: `album_genres` carries no `position`, so nothing
 * downstream reads its order. If that table ever gains one, it needs this too.
 */
export async function resolvePodcastCategoryIds(
  db: DbOrTransaction,
  names: readonly string[]
): Promise<string[]> {
  const byLowercase = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (!byLowercase.has(key)) byLowercase.set(key, name);
  }
  const wanted = [...byLowercase.values()];
  if (wanted.length === 0) return [];

  // No conflict TARGET: the index is functional (`lower(name)`), and an
  // untargeted `onConflictDoNothing` covers it without restating the expression
  // `schema/genres.ts` owns.
  await db
    .insert(genres)
    .values(wanted.map((name) => ({ name, kind: 'podcast' as const })))
    .onConflictDoNothing();

  // `name` is selected alongside `id` so the rows can be keyed back to the
  // caller's list — matching on `lower(name)` for the same reason the read
  // filters on it.
  const rows = await db
    .select({ id: genres.id, name: genres.name })
    .from(genres)
    .where(
      and(
        inArray(
          sql`lower(${genres.name})`,
          wanted.map((name) => name.toLowerCase())
        ),
        eq(genres.kind, 'podcast')
      )
    );

  const idByLowercaseName = new Map(rows.map((row) => [row.name.toLowerCase(), row.id]));

  // `flatMap` over an absent id rather than `map` + a non-null assertion: a
  // name that survived the upsert but did not read back would otherwise become
  // an `undefined` occupying a position.
  return wanted.flatMap((name) => {
    const id = idByLowercaseName.get(name.toLowerCase());
    return id === undefined ? [] : [id];
  });
}

/**
 * Replace a show's category links with exactly `names`, IN ORDER.
 *
 * `position` carries the feed's own ordering, which matters here in a way it
 * does not for a set: RSS declares the primary category first, so index 0 is
 * information rather than an accident of iteration.
 *
 * `resolvePodcastCategoryIds` returns its ids in the caller's order, and that
 * is a property it has to go out of its way to provide rather than one a
 * `SELECT … IN (…)` gives for free — see its own doc comment for the defect
 * that proved it.
 */
export async function setPodcastCategories(
  db: DbOrTransaction,
  podcastId: string,
  names: readonly string[]
): Promise<void> {
  const genreIds = await resolvePodcastCategoryIds(db, names);

  await db.delete(podcastCategories).where(eq(podcastCategories.podcastId, podcastId));
  if (genreIds.length === 0) return;

  await db
    .insert(podcastCategories)
    .values(
      genreIds.map((genreId, position) => ({
        podcastId,
        genreId,
        position,
        kind: 'podcast' as const,
      }))
    );
}

/** Replace a show's `<podcast:funding>` links. */
export async function setPodcastFunding(
  db: DbOrTransaction,
  podcastId: string,
  funding: readonly PodcastFunding[]
): Promise<void> {
  await db.delete(podcastFunding).where(eq(podcastFunding.podcastId, podcastId));
  if (funding.length === 0) return;

  await db.insert(podcastFunding).values(
    funding.map((entry, position) => ({
      podcastId,
      position,
      url: entry.url,
      message: entry.message ?? null,
    }))
  );
}

/**
 * The six columns a credit carries, shared by both person tables.
 *
 * Written once rather than twice because `podcast_persons` and `episode_persons`
 * are the same six columns under two parents — but the two INSERTS below stay
 * separate and fully typed rather than going through a shared helper over an
 * un-narrowed table type, which is the untyped seam that let a drizzle row reach
 * `formatTracksWithCoverArt(tracks: any[])` and answer `{"id":""}`.
 */
function creditColumns(credit: EpisodePerson, position: number) {
  return {
    position,
    name: credit.name,
    role: credit.role ?? null,
    group: credit.group ?? null,
    img: credit.img ?? null,
    href: credit.href ?? null,
    linkedOxyUserId: credit.linkedOxyUserId ?? null,
  };
}

/** Replace a show's channel-level Hosts & Guests. */
export async function setPodcastPersons(
  db: DbOrTransaction,
  podcastId: string,
  persons: readonly EpisodePerson[]
): Promise<void> {
  await db.delete(podcastPersons).where(eq(podcastPersons.podcastId, podcastId));
  if (persons.length === 0) return;

  await db
    .insert(podcastPersons)
    .values(persons.map((credit, position) => ({ podcastId, ...creditColumns(credit, position) })));
}

/** Replace a show's provenance log. */
export async function setPodcastSources(
  db: DbOrTransaction,
  podcastId: string,
  sources: readonly PodcastSourceProvenance[]
): Promise<void> {
  await db.delete(podcastSources).where(eq(podcastSources.podcastId, podcastId));
  if (sources.length === 0) return;

  await db.insert(podcastSources).values(
    sources.map((entry, position) => ({
      podcastId,
      position,
      provider: entry.provider,
      externalId: entry.externalId,
      importedAt: entry.importedAt,
      fields: entry.fields,
    }))
  );
}

/** Replace an episode's transcripts. */
export async function setEpisodeTranscripts(
  db: DbOrTransaction,
  episodeId: string,
  transcripts: readonly EpisodeTranscript[]
): Promise<void> {
  await db.delete(episodeTranscripts).where(eq(episodeTranscripts.episodeId, episodeId));
  if (transcripts.length === 0) return;

  await db.insert(episodeTranscripts).values(
    transcripts.map((entry, position) => ({
      episodeId,
      position,
      url: entry.url,
      type: entry.type,
      language: entry.language ?? null,
    }))
  );
}

/** Replace an episode's per-episode Hosts & Guests. */
export async function setEpisodePersons(
  db: DbOrTransaction,
  episodeId: string,
  persons: readonly EpisodePerson[]
): Promise<void> {
  await db.delete(episodePersons).where(eq(episodePersons.episodeId, episodeId));
  if (persons.length === 0) return;

  await db
    .insert(episodePersons)
    .values(persons.map((credit, position) => ({ episodeId, ...creditColumns(credit, position) })));
}

/** Replace an episode's HLS ladder — written by `ingestEpisode` on success. */
export async function setEpisodeHlsRenditions(
  db: DbOrTransaction,
  episodeId: string,
  renditions: readonly HlsRendition[]
): Promise<void> {
  await db.delete(episodeHlsRenditions).where(eq(episodeHlsRenditions.episodeId, episodeId));
  if (renditions.length === 0) return;

  await db.insert(episodeHlsRenditions).values(
    renditions.map((entry, position) => ({
      episodeId,
      position,
      manifestKey: entry.manifestKey,
      bitrateKbps: entry.bitrateKbps,
      encrypted: entry.encrypted,
    }))
  );
}
