-- oxy:deploy-phase=post
-- Drops genres_name_key (WIDENS what's permitted — safe on its own) and both
-- junctions' old single-column genre_id FKs, replacing them with composite
-- (genre_id, kind) -> genres(id, kind) FKs that actually enforce kind-
-- matching — a real narrowing, and the whole reason for this stage. Task 4
-- review, I7 stage 2 of 2 (0007 was stage 1, pre). Per the C1 ruling's own
-- corollary: this narrows, so it goes on the post side even though the two
-- ADD COLUMN "kind" statements are additive on their own.
--
-- DATA PRECONDITION, not just an ordering one: this migration is safe only
-- because genres, album_genres, and podcast_categories are EMPTY. 0007 gave
-- every pre-existing genres row `kind = 'music'` by DEFAULT; a genres row a
-- podcast_categories entry already pointed at before 0007 ran would have
-- become `kind = 'music'` under a `kind = 'podcast'`-only consumer, and this
-- migration's composite FK would then reject that podcast_categories row
-- outright. There is no backfill here because there is nothing to back
-- fill: no production Postgres deploy exists yet for either table to hold
-- real rows in (see migrate.ts's "THE GENESIS BOOTSTRAP WINDOW", which is
-- why LAST_GENESIS_MIGRATION_TAG covers this file). A backfill UPDATE would
-- be dead code — it would never execute against the one database this ever
-- runs against — so it is deliberately not here; this comment is the
-- precondition instead. Re-derive the backfill before letting this shape
-- run again if it is ever replayed against a database that already holds
-- genre data.
ALTER TABLE "genres" DROP CONSTRAINT "genres_name_key";--> statement-breakpoint
ALTER TABLE "album_genres" DROP CONSTRAINT "album_genres_genre_id_genres_id_fk";
--> statement-breakpoint
ALTER TABLE "podcast_categories" DROP CONSTRAINT "podcast_categories_genre_id_genres_id_fk";
--> statement-breakpoint
ALTER TABLE "album_genres" ADD COLUMN "kind" text DEFAULT 'music' NOT NULL;--> statement-breakpoint
ALTER TABLE "podcast_categories" ADD COLUMN "kind" text DEFAULT 'podcast' NOT NULL;--> statement-breakpoint
ALTER TABLE "album_genres" ADD CONSTRAINT "album_genres_genre_id_kind_genres_id_kind_fk" FOREIGN KEY ("genre_id","kind") REFERENCES "public"."genres"("id","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcast_categories" ADD CONSTRAINT "podcast_categories_genre_id_kind_genres_id_kind_fk" FOREIGN KEY ("genre_id","kind") REFERENCES "public"."genres"("id","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "genres" ADD CONSTRAINT "genres_name_kind_key" UNIQUE("name","kind");--> statement-breakpoint
ALTER TABLE "album_genres" ADD CONSTRAINT "album_genres_kind_check" CHECK ("album_genres"."kind" = 'music');--> statement-breakpoint
ALTER TABLE "podcast_categories" ADD CONSTRAINT "podcast_categories_kind_check" CHECK ("podcast_categories"."kind" = 'podcast');