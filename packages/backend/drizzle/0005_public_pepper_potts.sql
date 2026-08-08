-- oxy:deploy-phase=post
-- Contains a DROP COLUMN (tracks.hls, replaced by the track_hls_renditions
-- table this same migration creates — the corrected sibling of
-- episode_hls_renditions from 0004) — unsafe while a previous image still
-- reads that column, so the whole file is `post` even though the CREATE
-- TABLE half is additive on its own. Same shape as
-- 0001_yielding_black_queen's tracks.sources -> track_sources migration.
CREATE TABLE "track_hls_renditions" (
	"id" text PRIMARY KEY NOT NULL,
	"track_id" text NOT NULL,
	"position" integer NOT NULL,
	"manifest_key" text NOT NULL,
	"bitrate_kbps" integer NOT NULL,
	"encrypted" boolean NOT NULL,
	CONSTRAINT "track_hls_renditions_track_id_position_key" UNIQUE("track_id","position"),
	CONSTRAINT "track_hls_renditions_position_check" CHECK ("track_hls_renditions"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "track_hls_renditions" ADD CONSTRAINT "track_hls_renditions_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" DROP COLUMN "hls";