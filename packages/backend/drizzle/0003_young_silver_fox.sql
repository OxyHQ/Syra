-- oxy:deploy-phase=pre
-- Purely additive: 12 new tables (library and playlist schema — Task 3),
-- nothing dropped, renamed or narrowed on anything that already exists. Safe
-- to apply while the previous image (which has never heard of these tables)
-- is still serving.
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"capabilities" text[] DEFAULT array[]::text[] NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "devices_oxy_user_id_device_id_key" UNIQUE("oxy_user_id","device_id"),
	CONSTRAINT "devices_type_check" CHECK ("devices"."type" in ('web', 'mobile', 'desktop', 'speaker'))
);
--> statement-breakpoint
CREATE TABLE "playback_states" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"track_id" text,
	"source" text,
	"position_ms" integer DEFAULT 0 NOT NULL,
	"is_playing" boolean DEFAULT false NOT NULL,
	"queue" text[] DEFAULT array[]::text[] NOT NULL,
	"context_type" text,
	"context_id" text,
	"repeat" text DEFAULT 'off' NOT NULL,
	"shuffle" boolean DEFAULT false NOT NULL,
	"volume" double precision DEFAULT 1 NOT NULL,
	"active_device_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "playback_states_oxy_user_id_key" UNIQUE("oxy_user_id"),
	CONSTRAINT "playback_states_source_check" CHECK ("playback_states"."source" is null or "playback_states"."source" in ('upload', 'cc')),
	CONSTRAINT "playback_states_repeat_check" CHECK ("playback_states"."repeat" in ('off', 'all', 'one')),
	CONSTRAINT "playback_states_position_ms_check" CHECK ("playback_states"."position_ms" >= 0),
	CONSTRAINT "playback_states_volume_check" CHECK ("playback_states"."volume" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "playlist_collaborators" (
	"id" text PRIMARY KEY NOT NULL,
	"playlist_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"username" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	CONSTRAINT "playlist_collaborators_playlist_id_oxy_user_id_key" UNIQUE("playlist_id","oxy_user_id"),
	CONSTRAINT "playlist_collaborators_role_check" CHECK ("playlist_collaborators"."role" in ('owner', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "playlist_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"playlist_id" text NOT NULL,
	"position" integer NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"fields" text[] DEFAULT array[]::text[] NOT NULL,
	CONSTRAINT "playlist_sources_playlist_id_position_key" UNIQUE("playlist_id","position"),
	CONSTRAINT "playlist_sources_provider_check" CHECK ("playlist_sources"."provider" in ('upload', 'cc', 'musicbrainz', 'wikidata', 'wikimedia-commons', 'cover-art-archive', 'discogs')),
	CONSTRAINT "playlist_sources_position_check" CHECK ("playlist_sources"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "playlist_tracks" (
	"id" text PRIMARY KEY NOT NULL,
	"playlist_id" text NOT NULL,
	"track_id" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	"added_by" text,
	"position" integer NOT NULL,
	CONSTRAINT "playlist_tracks_playlist_id_position_key" UNIQUE("playlist_id","position"),
	CONSTRAINT "playlist_tracks_position_check" CHECK ("playlist_tracks"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_oxy_user_id" text NOT NULL,
	"owner_username" text NOT NULL,
	"cover_art_id" text,
	"cover_art_sizes_small_id" text,
	"cover_art_sizes_medium_id" text,
	"cover_art_sizes_large_id" text,
	"cover_art_sizes_xlarge_id" text,
	"cover_art_sizes_xxlarge_id" text,
	"cover_art_sizes_original_id" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"track_count" integer DEFAULT 0 NOT NULL,
	"total_duration" double precision DEFAULT 0 NOT NULL,
	"followers" integer DEFAULT 0 NOT NULL,
	"primary_color" text,
	"secondary_color" text,
	"source" text,
	"external_isrc" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', name || ' ' || coalesce(description, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "playlists_visibility_check" CHECK ("playlists"."visibility" in ('public', 'private', 'unlisted')),
	CONSTRAINT "playlists_source_check" CHECK ("playlists"."source" is null or "playlists"."source" in ('upload', 'cc'))
);
--> statement-breakpoint
CREATE TABLE "recently_played" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"track_id" text NOT NULL,
	"played_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_followed_artists" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"artist_id" text NOT NULL,
	CONSTRAINT "user_followed_artists_oxy_user_id_artist_id_key" UNIQUE("oxy_user_id","artist_id")
);
--> statement-breakpoint
CREATE TABLE "user_liked_tracks" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"track_id" text NOT NULL,
	CONSTRAINT "user_liked_tracks_oxy_user_id_track_id_key" UNIQUE("oxy_user_id","track_id")
);
--> statement-breakpoint
CREATE TABLE "user_podcast_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"podcast_id" text NOT NULL,
	CONSTRAINT "user_podcast_subscriptions_oxy_user_id_podcast_id_key" UNIQUE("oxy_user_id","podcast_id")
);
--> statement-breakpoint
CREATE TABLE "user_saved_albums" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"album_id" text NOT NULL,
	CONSTRAINT "user_saved_albums_oxy_user_id_album_id_key" UNIQUE("oxy_user_id","album_id")
);
--> statement-breakpoint
CREATE TABLE "user_saved_playlists" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"playlist_id" text NOT NULL,
	CONSTRAINT "user_saved_playlists_oxy_user_id_playlist_id_key" UNIQUE("oxy_user_id","playlist_id")
);
--> statement-breakpoint
ALTER TABLE "playback_states" ADD CONSTRAINT "playback_states_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_collaborators" ADD CONSTRAINT "playlist_collaborators_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_sources" ADD CONSTRAINT "playlist_sources_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_tracks" ADD CONSTRAINT "playlist_tracks_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_tracks" ADD CONSTRAINT "playlist_tracks_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_cover_art_id_image_assets_id_fk" FOREIGN KEY ("cover_art_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_cover_art_sizes_small_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_small_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_cover_art_sizes_medium_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_medium_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_cover_art_sizes_large_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_large_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_cover_art_sizes_xlarge_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_xlarge_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_cover_art_sizes_xxlarge_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_xxlarge_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_cover_art_sizes_original_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_original_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recently_played" ADD CONSTRAINT "recently_played_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_followed_artists" ADD CONSTRAINT "user_followed_artists_artist_id_catalog_entities_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."catalog_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_liked_tracks" ADD CONSTRAINT "user_liked_tracks_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_saved_albums" ADD CONSTRAINT "user_saved_albums_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_saved_playlists" ADD CONSTRAINT "user_saved_playlists_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playlist_collaborators_oxy_user_id_idx" ON "playlist_collaborators" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "playlist_tracks_playlist_id_track_id_idx" ON "playlist_tracks" USING btree ("playlist_id","track_id");--> statement-breakpoint
CREATE INDEX "playlists_owner_oxy_user_id_created_at_idx" ON "playlists" USING btree ("owner_oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "playlists_public_followers_idx" ON "playlists" USING btree ("followers" DESC NULLS LAST,"created_at" DESC NULLS LAST) WHERE "playlists"."visibility" = 'public';--> statement-breakpoint
CREATE INDEX "playlists_search_gin" ON "playlists" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "recently_played_oxy_user_id_played_at_idx" ON "recently_played" USING btree ("oxy_user_id","played_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_podcast_subscriptions_podcast_id_idx" ON "user_podcast_subscriptions" USING btree ("podcast_id");