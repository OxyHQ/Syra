-- oxy:deploy-phase=post
-- Contains a DROP COLUMN (tracks.sources, replaced by the track_sources
-- table this same migration creates) — unsafe while a previous image still
-- reads that column, so the whole file is `post` even though the CREATE
-- TABLE half is additive on its own.
CREATE TABLE "track_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"track_id" text NOT NULL,
	"position" integer NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"fields" text[] DEFAULT array[]::text[] NOT NULL,
	CONSTRAINT "track_sources_track_id_position_key" UNIQUE("track_id","position"),
	CONSTRAINT "track_sources_provider_check" CHECK ("track_sources"."provider" in ('upload', 'cc', 'musicbrainz', 'wikidata', 'wikimedia-commons', 'cover-art-archive', 'discogs')),
	CONSTRAINT "track_sources_position_check" CHECK ("track_sources"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "track_sources" ADD CONSTRAINT "track_sources_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" DROP COLUMN "sources";