-- oxy:deploy-phase=pre
-- Additive listener tools. Foreign keys are declared on new empty tables.
CREATE TABLE "artist_curated_playlists" (
	CONSTRAINT "artist_curated_playlists_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "artist_curated_playlists_artist_id_catalog_entities_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."catalog_entities"("id") ON DELETE cascade ON UPDATE no action,
	"id" text PRIMARY KEY NOT NULL,
	"artist_id" text NOT NULL,
	"playlist_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "artist_curated_playlists_artist_playlist_key" UNIQUE("artist_id","playlist_id"),
	CONSTRAINT "artist_curated_playlists_artist_position_key" UNIQUE("artist_id","position"),
	CONSTRAINT "artist_curated_playlists_position_check" CHECK ("artist_curated_playlists"."position" between 0 and 9)
);
--> statement-breakpoint
CREATE TABLE "playlist_import_receipts" (
	CONSTRAINT "playlist_import_receipts_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action,
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"playlist_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "playlist_import_receipts_user_request_key" UNIQUE("oxy_user_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "taste_mixes" (
	CONSTRAINT "taste_mixes_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action,
	"id" text PRIMARY KEY NOT NULL,
	"host_oxy_user_id" text NOT NULL,
	"host_username" text NOT NULL,
	"guest_oxy_user_id" text,
	"token_hash" text NOT NULL,
	"playlist_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "taste_mixes_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "taste_mixes_different_people_check" CHECK ("taste_mixes"."guest_oxy_user_id" is null or "taste_mixes"."guest_oxy_user_id" <> "taste_mixes"."host_oxy_user_id")
);
--> statement-breakpoint
CREATE TABLE "track_download_policies" (
	CONSTRAINT "track_download_policies_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action,
	"track_id" text PRIMARY KEY NOT NULL,
	"allowed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "artist_curated_playlists_playlist_id_idx" ON "artist_curated_playlists" USING btree ("playlist_id");--> statement-breakpoint
CREATE INDEX "playlist_import_receipts_playlist_idx" ON "playlist_import_receipts" USING btree ("playlist_id");--> statement-breakpoint
CREATE INDEX "taste_mixes_host_idx" ON "taste_mixes" USING btree ("host_oxy_user_id");--> statement-breakpoint
CREATE INDEX "taste_mixes_guest_idx" ON "taste_mixes" USING btree ("guest_oxy_user_id");--> statement-breakpoint
CREATE INDEX "taste_mixes_playlist_idx" ON "taste_mixes" USING btree ("playlist_id");--> statement-breakpoint
CREATE INDEX "taste_mixes_expires_idx" ON "taste_mixes" USING btree ("expires_at");
