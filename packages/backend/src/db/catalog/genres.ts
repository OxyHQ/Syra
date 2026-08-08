/**
 * Music genres as rows, and an album's membership in them.
 *
 * `Album.genre` was a bare `string[]` in Mongo. `schema/genres.ts` explains why
 * it is a real table now — "what genres EXIST across the catalogue" cannot be
 * answered from an array without scanning every row — and this module is the
 * write side of that: the one place that turns the genre NAMES a tag block or an
 * importer hands us into `genres` rows and `album_genres` links.
 *
 * ## Everything here is scoped to `kind = 'music'`
 *
 * `genres` serves two verticals. Uniqueness is per kind, so "Comedy" the podcast
 * category and "Comedy" the music genre are two rows, and a music junction that
 * resolved a name without the kind would attach an album to whichever of the two
 * happened to be inserted first. `album_genres` also carries a composite FK to
 * `(genres.id, genres.kind)` that would refuse the row — but a constraint
 * violation at write time is a worse way to learn this than simply asking the
 * right question.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type DbOrTransaction } from '../postgres';
import { albumGenres } from '../schema/catalog';
import { genres } from '../schema/genres';

/**
 * Trim, drop blanks and de-duplicate case-insensitively, keeping the FIRST
 * spelling seen.
 *
 * Tag blocks routinely carry `Rock`, `rock` and ` Rock ` for one album. This
 * collapses them WITHIN one call; `genres_lower_name_kind_key` — a unique index
 * on `(lower(name), kind)` — is what collapses them ACROSS calls.
 *
 * Both halves are needed and the first version of this module shipped only this
 * one, which is why the pair is spelled out. With a case-SENSITIVE constraint,
 * `['Rock']` then `['rock']` created two rows and the second call returned only
 * the new one, so the album linked to a duplicate: the exact "three cards for
 * one genre" outcome this comment used to claim was prevented. See
 * `schema/genres.ts` and migration `0019`.
 */
function normalizeGenreNames(names: readonly string[]): string[] {
  const byLowercase = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (!byLowercase.has(key)) byLowercase.set(key, name);
  }
  return [...byLowercase.values()];
}

/**
 * Resolve genre NAMES to `genres.id`s, creating any that do not exist yet.
 *
 * `onConflictDoNothing` plus a follow-up read rather than `onConflictDoUpdate`:
 * there is nothing to update — a genre is its name — and two uploads naming the
 * same new genre at once must end with one row, not a failed insert.
 */
export async function resolveMusicGenreIds(
  db: DbOrTransaction,
  names: readonly string[]
): Promise<string[]> {
  const wanted = normalizeGenreNames(names);
  if (wanted.length === 0) return [];

  // No conflict TARGET: the index is functional (`lower(name)`), and an
  // untargeted `onConflictDoNothing` covers it without this module having to
  // restate the expression the schema already owns.
  await db
    .insert(genres)
    .values(wanted.map((name) => ({ name, kind: 'music' as const })))
    .onConflictDoNothing();

  /**
   * Read back through `lower()`, matching the index.
   *
   * Two reasons, and the second is the one that bit. Trusting `returning()` is
   * wrong because `onConflictDoNothing` returns nothing for rows that already
   * existed — which is most of them. And matching on the EXACT name is wrong
   * because the row that already exists may carry a different spelling: an
   * exact `inArray(genres.name, ['rock'])` misses a stored `"Rock"`, which is
   * how the duplicate got created in the first place.
   */
  const lowered = wanted.map((name) => name.toLowerCase());
  const rows = await db
    .select({ id: genres.id })
    .from(genres)
    .where(and(inArray(sql`lower(${genres.name})`, lowered), eq(genres.kind, 'music')));

  return rows.map((row) => row.id);
}

/**
 * Replace an album's genre links with exactly `names`.
 *
 * Delete-then-insert, not append: this is called on create AND on re-enrichment,
 * and appending would accumulate a second copy of every genre the second time
 * — `album_genres` is unique on `(album_id, genre_id)`, so the duplicate would
 * fail the write rather than corrupt the read, but the write is the one that
 * must succeed.
 */
export async function setAlbumGenres(
  db: DbOrTransaction,
  albumId: string,
  names: readonly string[]
): Promise<void> {
  const genreIds = await resolveMusicGenreIds(db, names);

  await db.delete(albumGenres).where(eq(albumGenres.albumId, albumId));

  if (genreIds.length === 0) return;

  await db
    .insert(albumGenres)
    .values(genreIds.map((genreId) => ({ albumId, genreId, kind: 'music' as const })));
}

/** The genre names linked to one album, for a DTO's `genre` field. */
export async function albumGenreNames(albumId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ name: genres.name })
    .from(albumGenres)
    .innerJoin(genres, eq(genres.id, albumGenres.genreId))
    .where(eq(albumGenres.albumId, albumId));

  return rows.map((row) => row.name);
}
