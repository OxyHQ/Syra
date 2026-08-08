/**
 * `genres` — the real, enumerable genre taxonomy.
 *
 * Mongo let `Album.genre` be a bare `string[]`, and the genre-card browse
 * feature (and, on the track side, `browse.controller.ts`'s `distinct('genre',
 * ...)`) worked by scanning every stored value for the distinct set. A
 * Postgres `text[]` can answer "does this row's array contain X" (with a GIN
 * index) but cannot answer "what genres EXIST across the whole catalog"
 * without the same kind of scan Mongo already did — so a genre becomes a real
 * row here, and `album_genres` (in `catalog.ts`, alongside the `albums` table
 * it joins) is the junction that replaces the array.
 *
 * ## `kind` — two verticals, one table, a discriminator between them
 *
 * Task 4 (`podcast_categories`, `podcasts.ts`) joined `Podcast.categories[]`
 * against this SAME table, on the reasoning that its enumeration answers the
 * identical question for a second vertical. That made the file-level claim
 * above too broad the moment it landed: "what genres EXIST across the whole
 * catalog" is now really "what genres exist FOR A GIVEN VERTICAL" — `select
 * name from genres` mixes "True Crime" and "Shoegaze" with nothing to tell
 * them apart, which is exactly the query this table exists to make possible.
 * Product ruling (routed through the Task 4 review, I7): one `genres` table
 * with a `kind` discriminator, not two separate tables. `GENRE_KINDS` is the
 * closed value set, same `as const` + CHECK convention as every other one in
 * this schema.
 *
 * `genres_id_kind_key` — a unique constraint on `(id, kind)`, REDUNDANT
 * against the primary key on its own (`id` alone is already unique) — exists
 * SOLELY so it can be the target of a composite foreign key. Postgres cannot
 * reference a plain single-column primary key from a composite FK that also
 * wants to pin the foreign row's `kind`; the referenced columns have to be
 * covered by a unique (or primary key) constraint of their own. Without this,
 * nothing stops a music junction (`album_genres`) from pointing at a
 * `kind = 'podcast'` row — the whole reason to prefer this over an unwritten
 * "don't do that" convention. See `catalog.ts`'s `album_genres` and
 * `podcasts.ts`'s `podcast_categories` for the composite FKs that reference
 * this pair.
 *
 * `genres_lower_name_kind_key` replaces the old bare `unique(name)`:
 * uniqueness is scoped PER KIND, not global. A global unique would resurrect
 * the same cross-vertical collision this whole change exists to close from the
 * other side — a podcast category and a music genre that happen to share a
 * name (an unremarkable coincidence: "Comedy" is a real Apple Music genre AND
 * a plausible podcast category) would fight over one row instead of each
 * vertical owning its own.
 *
 * ## It is unique on `lower(name)`, and the plain version was a live defect
 *
 * Task 10b shipped `unique(name, kind)`, which is case-SENSITIVE, while
 * `db/catalog/genres.ts` de-duplicated its INPUT case-insensitively and
 * documented the pair as preventing duplicates. It prevented them only within a
 * single call. Measured on a migrated database: `resolveMusicGenreIds(['Rock'])`
 * then `resolveMusicGenreIds(['rock', ' Rock '])` left rows `["Rock", "rock"]`
 * and returned only the second row's id, so the album linked to the duplicate —
 * exactly the "three cards for one genre" outcome the function's own comment
 * claimed it prevented, live on the upload path.
 *
 * A FUNCTIONAL unique index is the fix rather than canonicalising the stored
 * case, because the stored case is what the browse surface renders: "Drum & Bass"
 * must display that way whoever typed it, and lowercasing every genre to make a
 * constraint work would push a display decision into the storage layer. The
 * first spelling to arrive wins the row and later spellings resolve to it.
 *
 * Deliberately just a name and a kind: no colour, no icon, no sort order.
 * Every one of those was presentation state the Mongo browse controller
 * derived at read time (`GENRE_COLORS[genre]`), never stored — carrying it
 * here would give a genre row two owners.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxyhq/db';

/** The two verticals sharing this table's vocabulary. */
export const GENRE_KINDS = ['music', 'podcast'] as const;

export const genres = pgTable(
  'genres',
  {
    id: generatedId(),
    name: text().notNull(),
    /**
     * Defaults to `'music'`: every genre this table held before this column
     * existed came from `album_genres` (Task 2), the only vertical that
     * wrote to this table until Task 4's `podcast_categories`. See the
     * file-level doc comment.
     */
    kind: text({ enum: GENRE_KINDS }).notNull().default('music'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('genres_kind_check', sql`${t.kind} in (${sql.raw(inList(GENRE_KINDS))})`),
    /**
     * `lower(name)`, not `name`. See the file-level doc comment: the plain
     * version admitted `Rock` and `rock` as two rows, and every reader of this
     * table is an enumeration ("what genres exist"), where a duplicate is the
     * whole failure. `db/catalog/genres.ts` reads back through `lower()` to
     * match, so the constraint and the query agree by construction.
     */
    uniqueIndex('genres_lower_name_kind_key').on(sql`lower(${t.name})`, t.kind),
    // FK-target-only — see the file-level doc comment.
    unique('genres_id_kind_key').on(t.id, t.kind),
  ]
);
