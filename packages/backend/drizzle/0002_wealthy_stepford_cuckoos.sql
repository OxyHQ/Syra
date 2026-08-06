-- oxy:deploy-phase=post
-- The index DROP/CREATE pairs and the new column DEFAULTs are additive on
-- their own, but catalog_entities_source_required_for_artist_check narrows
-- what's permitted (an artist row with a NULL source, previously accepted,
-- is now rejected) — a `post` change per @oxyhq/db/migrate's own rule, so the
-- whole file goes on that side.
DROP INDEX "tracks_artist_id_album_id_idx";--> statement-breakpoint
DROP INDEX "tracks_popularity_idx";--> statement-breakpoint
DROP INDEX "tracks_play_count_idx";--> statement-breakpoint
DROP INDEX "tracks_created_at_idx";--> statement-breakpoint
DROP INDEX "tracks_genre_idx";--> statement-breakpoint
ALTER TABLE "catalog_entities" ALTER COLUMN "genres" SET DEFAULT array[]::text[];--> statement-breakpoint
ALTER TABLE "catalog_entities" ALTER COLUMN "aliases" SET DEFAULT array[]::text[];--> statement-breakpoint
ALTER TABLE "catalog_entities" ALTER COLUMN "labels" SET DEFAULT array[]::text[];--> statement-breakpoint
CREATE INDEX "tracks_mood_idx" ON "tracks" USING btree ("mood") WHERE "tracks"."is_available" = true and "tracks"."copyright_removed" = false;--> statement-breakpoint
CREATE INDEX "tracks_artist_id_album_id_idx" ON "tracks" USING btree ("artist_id","album_id") WHERE "tracks"."is_available" = true and "tracks"."copyright_removed" = false;--> statement-breakpoint
CREATE INDEX "tracks_popularity_idx" ON "tracks" USING btree ("popularity" DESC NULLS LAST) WHERE "tracks"."is_available" = true and "tracks"."copyright_removed" = false;--> statement-breakpoint
CREATE INDEX "tracks_play_count_idx" ON "tracks" USING btree ("play_count" DESC NULLS LAST) WHERE "tracks"."is_available" = true and "tracks"."copyright_removed" = false;--> statement-breakpoint
CREATE INDEX "tracks_created_at_idx" ON "tracks" USING btree ("created_at" DESC NULLS LAST) WHERE "tracks"."is_available" = true and "tracks"."copyright_removed" = false;--> statement-breakpoint
CREATE INDEX "tracks_genre_idx" ON "tracks" USING btree ("genre") WHERE "tracks"."is_available" = true and "tracks"."copyright_removed" = false;--> statement-breakpoint
ALTER TABLE "catalog_entities" ADD CONSTRAINT "catalog_entities_source_required_for_artist_check" CHECK ("catalog_entities"."type" != 'artist' or "catalog_entities"."source" is not null);