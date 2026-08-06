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
 * it joins) is the junction that replaces the array. Podcast's `categories`
 * junction lands in Task 4 against this same table — see
 * `deferredForeignKeys.ts`.
 *
 * Deliberately just a name: no colour, no icon, no sort order. Every one of
 * those was presentation state the Mongo browse controller derived at read
 * time (`GENRE_COLORS[genre]`), never stored — carrying it here would give a
 * genre row two owners.
 */

import { pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';

export const genres = pgTable(
  'genres',
  {
    id: generatedId(),
    name: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('genres_name_key').on(t.name)]
);
