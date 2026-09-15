-- oxy:deploy-phase=pre
--
-- All 49 `image_assets.id` FK columns across the 7 referencing tables get an
-- index here. None had one: Postgres never indexes a foreign key column on
-- its own, and `ON DELETE SET NULL` still has to find every referencing row
-- when the referenced `image_assets` row is deleted — unindexed, that is a
-- sequential scan of the WHOLE referencing table, once PER FK constraint
-- PER DELETED ROW.
--
-- Found live, not in review: `consolidateDuplicateCatalogImages.ts`
-- (production cleanup for already-duplicated images) deleted one batch of a
-- few hundred `image_assets` rows and the DELETE ran for 30+ minutes, during
-- which it held locks that blocked the concurrently-running episode-image
-- backfill's own `INSERT INTO episodes` — a live write path stalled by an
-- offline maintenance script. `pg_stat_activity` showed the DELETE itself
-- still active (not waiting), which is consistent with Postgres's own
-- `RI_FKey_setnull_del` trigger firing once per FK constraint per deleted row
-- and, for a table this size, defaulting to a Seq Scan.
--
-- Plain CREATE INDEX, not CONCURRENTLY (same reasoning as
-- `0021_signed_records_author_feed_index.sql` in the `oxy` repo): the
-- migrator runs inside a transaction and CONCURRENTLY cannot. Writes to the
-- table being indexed block while its index builds — reads are unaffected,
-- since a non-concurrent build takes SHARE, not ACCESS EXCLUSIVE.
--
-- Row counts measured live before writing this (2026-09-15): `episodes`
-- ~411k, `podcasts` ~1.6k, `catalog_entities`/`albums`/`tracks` single digits,
-- `user_uploads`/`playlists` empty. `episodes`' seven indexes are the only
-- ones with real build time; the other 42 are instant at this size but are
-- added for every table regardless, because the FK's risk is about the
-- REFERENCING table's row count, not today's count — the whole point of this
-- migration is that "it's small today" is exactly what let this go unindexed
-- until it caused a production incident.
CREATE INDEX "albums_cover_art_id_idx" ON "albums" USING btree ("cover_art_id");--> statement-breakpoint
CREATE INDEX "albums_cover_art_sizes_small_id_idx" ON "albums" USING btree ("cover_art_sizes_small_id");--> statement-breakpoint
CREATE INDEX "albums_cover_art_sizes_medium_id_idx" ON "albums" USING btree ("cover_art_sizes_medium_id");--> statement-breakpoint
CREATE INDEX "albums_cover_art_sizes_large_id_idx" ON "albums" USING btree ("cover_art_sizes_large_id");--> statement-breakpoint
CREATE INDEX "albums_cover_art_sizes_xlarge_id_idx" ON "albums" USING btree ("cover_art_sizes_xlarge_id");--> statement-breakpoint
CREATE INDEX "albums_cover_art_sizes_xxlarge_id_idx" ON "albums" USING btree ("cover_art_sizes_xxlarge_id");--> statement-breakpoint
CREATE INDEX "albums_cover_art_sizes_original_id_idx" ON "albums" USING btree ("cover_art_sizes_original_id");--> statement-breakpoint
CREATE INDEX "catalog_entities_image_id_idx" ON "catalog_entities" USING btree ("image_id");--> statement-breakpoint
CREATE INDEX "catalog_entities_image_sizes_small_id_idx" ON "catalog_entities" USING btree ("image_sizes_small_id");--> statement-breakpoint
CREATE INDEX "catalog_entities_image_sizes_medium_id_idx" ON "catalog_entities" USING btree ("image_sizes_medium_id");--> statement-breakpoint
CREATE INDEX "catalog_entities_image_sizes_large_id_idx" ON "catalog_entities" USING btree ("image_sizes_large_id");--> statement-breakpoint
CREATE INDEX "catalog_entities_image_sizes_xlarge_id_idx" ON "catalog_entities" USING btree ("image_sizes_xlarge_id");--> statement-breakpoint
CREATE INDEX "catalog_entities_image_sizes_xxlarge_id_idx" ON "catalog_entities" USING btree ("image_sizes_xxlarge_id");--> statement-breakpoint
CREATE INDEX "catalog_entities_image_sizes_original_id_idx" ON "catalog_entities" USING btree ("image_sizes_original_id");--> statement-breakpoint
CREATE INDEX "tracks_cover_art_id_idx" ON "tracks" USING btree ("cover_art_id");--> statement-breakpoint
CREATE INDEX "tracks_cover_art_sizes_small_id_idx" ON "tracks" USING btree ("cover_art_sizes_small_id");--> statement-breakpoint
CREATE INDEX "tracks_cover_art_sizes_medium_id_idx" ON "tracks" USING btree ("cover_art_sizes_medium_id");--> statement-breakpoint
CREATE INDEX "tracks_cover_art_sizes_large_id_idx" ON "tracks" USING btree ("cover_art_sizes_large_id");--> statement-breakpoint
CREATE INDEX "tracks_cover_art_sizes_xlarge_id_idx" ON "tracks" USING btree ("cover_art_sizes_xlarge_id");--> statement-breakpoint
CREATE INDEX "tracks_cover_art_sizes_xxlarge_id_idx" ON "tracks" USING btree ("cover_art_sizes_xxlarge_id");--> statement-breakpoint
CREATE INDEX "tracks_cover_art_sizes_original_id_idx" ON "tracks" USING btree ("cover_art_sizes_original_id");--> statement-breakpoint
CREATE INDEX "user_uploads_cover_art_id_idx" ON "user_uploads" USING btree ("cover_art_id");--> statement-breakpoint
CREATE INDEX "user_uploads_cover_art_sizes_small_id_idx" ON "user_uploads" USING btree ("cover_art_sizes_small_id");--> statement-breakpoint
CREATE INDEX "user_uploads_cover_art_sizes_medium_id_idx" ON "user_uploads" USING btree ("cover_art_sizes_medium_id");--> statement-breakpoint
CREATE INDEX "user_uploads_cover_art_sizes_large_id_idx" ON "user_uploads" USING btree ("cover_art_sizes_large_id");--> statement-breakpoint
CREATE INDEX "user_uploads_cover_art_sizes_xlarge_id_idx" ON "user_uploads" USING btree ("cover_art_sizes_xlarge_id");--> statement-breakpoint
CREATE INDEX "user_uploads_cover_art_sizes_xxlarge_id_idx" ON "user_uploads" USING btree ("cover_art_sizes_xxlarge_id");--> statement-breakpoint
CREATE INDEX "user_uploads_cover_art_sizes_original_id_idx" ON "user_uploads" USING btree ("cover_art_sizes_original_id");--> statement-breakpoint
CREATE INDEX "playlists_cover_art_id_idx" ON "playlists" USING btree ("cover_art_id");--> statement-breakpoint
CREATE INDEX "playlists_cover_art_sizes_small_id_idx" ON "playlists" USING btree ("cover_art_sizes_small_id");--> statement-breakpoint
CREATE INDEX "playlists_cover_art_sizes_medium_id_idx" ON "playlists" USING btree ("cover_art_sizes_medium_id");--> statement-breakpoint
CREATE INDEX "playlists_cover_art_sizes_large_id_idx" ON "playlists" USING btree ("cover_art_sizes_large_id");--> statement-breakpoint
CREATE INDEX "playlists_cover_art_sizes_xlarge_id_idx" ON "playlists" USING btree ("cover_art_sizes_xlarge_id");--> statement-breakpoint
CREATE INDEX "playlists_cover_art_sizes_xxlarge_id_idx" ON "playlists" USING btree ("cover_art_sizes_xxlarge_id");--> statement-breakpoint
CREATE INDEX "playlists_cover_art_sizes_original_id_idx" ON "playlists" USING btree ("cover_art_sizes_original_id");--> statement-breakpoint
CREATE INDEX "episodes_image_id_idx" ON "episodes" USING btree ("image_id");--> statement-breakpoint
CREATE INDEX "episodes_image_sizes_small_id_idx" ON "episodes" USING btree ("image_sizes_small_id");--> statement-breakpoint
CREATE INDEX "episodes_image_sizes_medium_id_idx" ON "episodes" USING btree ("image_sizes_medium_id");--> statement-breakpoint
CREATE INDEX "episodes_image_sizes_large_id_idx" ON "episodes" USING btree ("image_sizes_large_id");--> statement-breakpoint
CREATE INDEX "episodes_image_sizes_xlarge_id_idx" ON "episodes" USING btree ("image_sizes_xlarge_id");--> statement-breakpoint
CREATE INDEX "episodes_image_sizes_xxlarge_id_idx" ON "episodes" USING btree ("image_sizes_xxlarge_id");--> statement-breakpoint
CREATE INDEX "episodes_image_sizes_original_id_idx" ON "episodes" USING btree ("image_sizes_original_id");--> statement-breakpoint
CREATE INDEX "podcasts_image_id_idx" ON "podcasts" USING btree ("image_id");--> statement-breakpoint
CREATE INDEX "podcasts_image_sizes_small_id_idx" ON "podcasts" USING btree ("image_sizes_small_id");--> statement-breakpoint
CREATE INDEX "podcasts_image_sizes_medium_id_idx" ON "podcasts" USING btree ("image_sizes_medium_id");--> statement-breakpoint
CREATE INDEX "podcasts_image_sizes_large_id_idx" ON "podcasts" USING btree ("image_sizes_large_id");--> statement-breakpoint
CREATE INDEX "podcasts_image_sizes_xlarge_id_idx" ON "podcasts" USING btree ("image_sizes_xlarge_id");--> statement-breakpoint
CREATE INDEX "podcasts_image_sizes_xxlarge_id_idx" ON "podcasts" USING btree ("image_sizes_xxlarge_id");--> statement-breakpoint
CREATE INDEX "podcasts_image_sizes_original_id_idx" ON "podcasts" USING btree ("image_sizes_original_id");