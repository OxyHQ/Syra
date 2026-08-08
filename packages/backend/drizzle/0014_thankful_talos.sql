-- oxy:deploy-phase=pre
-- ADDITIVE ONLY. Ten brand-new tables (Task 7, the user/taste/listening
-- vertical), the five foreign keys they declare, and seven indexes on them.
-- Nothing here drops, renames or narrows anything, and every ADD CONSTRAINT
-- below targets a table CREATE'd in this same file — the same shape as 0009,
-- whose FKs also reach pre-existing parents (tracks, catalog_entities). Those
-- parents gain a referential check on DELETE, but no INSERT or UPDATE the
-- image still serving performs can be rejected by it: that image knows nothing
-- about any of these tables, so it writes no rows into them to violate.
-- `drizzle-kit generate` produced this file unmodified apart from this header.
--
-- TWO OF THESE INDEXES ARE NOT AN OPTIMISATION. `listening_events_played_at_idx`
-- and `notification_suppressions_expires_at_idx` are what the expiry sweep
-- (`src/db/expiry.ts`, the replacement for the two Mongo TTL indexes this
-- vertical had) range-scans on every run. Dropping either turns a bounded
-- delete into a full scan of the largest table in this schema;
-- `findUnsupportedExpiryColumns` fails the gate if either goes missing.
CREATE TABLE "catalog_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"source_id" text NOT NULL,
	"target_id" text NOT NULL,
	"score" double precision NOT NULL,
	"co_count" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_relations_kind_source_id_target_id_key" UNIQUE("kind","source_id","target_id"),
	CONSTRAINT "catalog_relations_kind_check" CHECK ("catalog_relations"."kind" in ('track', 'artist')),
	CONSTRAINT "catalog_relations_score_check" CHECK ("catalog_relations"."score" >= 0),
	CONSTRAINT "catalog_relations_co_count_check" CHECK ("catalog_relations"."co_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "listening_events" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"track_id" text NOT NULL,
	"artist_id" text NOT NULL,
	"genre" text,
	"duration_sec" double precision,
	"listened_sec" double precision DEFAULT 0 NOT NULL,
	"completion" double precision DEFAULT 0 NOT NULL,
	"skipped" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'unknown' NOT NULL,
	"played_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "listening_events_listened_sec_check" CHECK ("listening_events"."listened_sec" >= 0),
	CONSTRAINT "listening_events_completion_check" CHECK ("listening_events"."completion" between 0 and 1),
	CONSTRAINT "listening_events_source_check" CHECK ("listening_events"."source" in ('search', 'library', 'playlist', 'album', 'artist', 'radio', 'recommendation', 'charts', 'queue', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"disabled_events" text[] DEFAULT array[]::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "notification_preferences_oxy_user_id_key" UNIQUE("oxy_user_id"),
	CONSTRAINT "notification_preferences_disabled_events_check" CHECK ("notification_preferences"."disabled_events" <@ array['episode.published', 'artist.release', 'room.started', 'playlist.collaboration', 'upload.expiring', 'upload.removed']::text[])
);
--> statement-breakpoint
CREATE TABLE "notification_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "notification_suppressions_oxy_user_id_key_key" UNIQUE("oxy_user_id","key")
);
--> statement-breakpoint
CREATE TABLE "user_behavior" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"preferred_authors" text[] DEFAULT array[]::text[] NOT NULL,
	"preferred_topics" text[] DEFAULT array[]::text[] NOT NULL,
	"preferred_post_types_text" integer DEFAULT 0 NOT NULL,
	"preferred_post_types_image" integer DEFAULT 0 NOT NULL,
	"preferred_post_types_video" integer DEFAULT 0 NOT NULL,
	"preferred_post_types_poll" integer DEFAULT 0 NOT NULL,
	"active_hours" integer[] DEFAULT array[]::integer[] NOT NULL,
	"preferred_languages" text[] DEFAULT array[]::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_behavior_oxy_user_id_key" UNIQUE("oxy_user_id"),
	CONSTRAINT "user_behavior_active_hours_check" CHECK ("user_behavior"."active_hours" <@ array[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]::integer[])
);
--> statement-breakpoint
CREATE TABLE "user_music_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"default_volume" double precision DEFAULT 0.7 NOT NULL,
	"autoplay" boolean DEFAULT true NOT NULL,
	"crossfade" double precision DEFAULT 0 NOT NULL,
	"gapless_playback" boolean DEFAULT true NOT NULL,
	"normalize_volume" boolean DEFAULT true NOT NULL,
	"explicit_content" boolean DEFAULT true NOT NULL,
	"audio_quality" text DEFAULT 'normal' NOT NULL,
	"download_quality" text DEFAULT 'normal' NOT NULL,
	"data_saver" boolean DEFAULT false NOT NULL,
	"mono_audio" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_music_preferences_oxy_user_id_key" UNIQUE("oxy_user_id"),
	CONSTRAINT "user_music_preferences_default_volume_check" CHECK ("user_music_preferences"."default_volume" between 0 and 1),
	CONSTRAINT "user_music_preferences_crossfade_check" CHECK ("user_music_preferences"."crossfade" between 0 and 12),
	CONSTRAINT "user_music_preferences_audio_quality_check" CHECK ("user_music_preferences"."audio_quality" in ('low', 'normal', 'high', 'very_high')),
	CONSTRAINT "user_music_preferences_download_quality_check" CHECK ("user_music_preferences"."download_quality" in ('low', 'normal', 'high', 'very_high'))
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"appearance_theme_mode" text DEFAULT 'system' NOT NULL,
	"appearance_primary_color" text,
	"profile_header_image" text,
	"privacy_profile_visibility" text DEFAULT 'public' NOT NULL,
	"privacy_show_contact_info" boolean DEFAULT true NOT NULL,
	"privacy_allow_tags" boolean DEFAULT true NOT NULL,
	"privacy_allow_mentions" boolean DEFAULT true NOT NULL,
	"privacy_show_online_status" boolean DEFAULT true NOT NULL,
	"privacy_hide_like_counts" boolean DEFAULT false NOT NULL,
	"privacy_hide_share_counts" boolean DEFAULT false NOT NULL,
	"privacy_hide_reply_counts" boolean DEFAULT false NOT NULL,
	"privacy_hide_save_counts" boolean DEFAULT false NOT NULL,
	"privacy_hidden_words" text[] DEFAULT array[]::text[] NOT NULL,
	"privacy_restricted_users" text[] DEFAULT array[]::text[] NOT NULL,
	"profile_customization_cover_photo_enabled" boolean DEFAULT true NOT NULL,
	"profile_customization_minimalist_mode" boolean DEFAULT false NOT NULL,
	"profile_customization_display_name" text,
	"profile_customization_cover_image" text,
	"interests_tags" text[] DEFAULT array[]::text[] NOT NULL,
	"feed_diversity_enabled" boolean DEFAULT true NOT NULL,
	"feed_diversity_same_author_penalty" double precision DEFAULT 0.95 NOT NULL,
	"feed_diversity_same_topic_penalty" double precision DEFAULT 0.92 NOT NULL,
	"feed_diversity_max_consecutive_same_author" integer,
	"feed_recency_half_life_hours" double precision DEFAULT 24 NOT NULL,
	"feed_recency_max_age_hours" double precision DEFAULT 168 NOT NULL,
	"feed_quality_min_engagement_rate" double precision,
	"feed_quality_boost_high_quality" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_settings_oxy_user_id_key" UNIQUE("oxy_user_id"),
	CONSTRAINT "user_settings_theme_mode_check" CHECK ("user_settings"."appearance_theme_mode" in ('light', 'dark', 'system')),
	CONSTRAINT "user_settings_profile_visibility_check" CHECK ("user_settings"."privacy_profile_visibility" in ('public', 'private', 'followers_only')),
	CONSTRAINT "user_settings_feed_diversity_same_author_penalty_check" CHECK ("user_settings"."feed_diversity_same_author_penalty" between 0.5 and 1.0),
	CONSTRAINT "user_settings_feed_diversity_same_topic_penalty_check" CHECK ("user_settings"."feed_diversity_same_topic_penalty" between 0.5 and 1.0),
	CONSTRAINT "user_settings_feed_diversity_max_consecutive_check" CHECK ("user_settings"."feed_diversity_max_consecutive_same_author" is null or "user_settings"."feed_diversity_max_consecutive_same_author" between 1 and 10),
	CONSTRAINT "user_settings_feed_recency_half_life_hours_check" CHECK ("user_settings"."feed_recency_half_life_hours" between 6 and 72),
	CONSTRAINT "user_settings_feed_recency_max_age_hours_check" CHECK ("user_settings"."feed_recency_max_age_hours" between 24 and 336),
	CONSTRAINT "user_settings_feed_quality_min_engagement_rate_check" CHECK ("user_settings"."feed_quality_min_engagement_rate" is null or "user_settings"."feed_quality_min_engagement_rate" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "user_taste_artists" (
	"id" text PRIMARY KEY NOT NULL,
	"taste_profile_id" text NOT NULL,
	"artist_id" text NOT NULL,
	"weight" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "user_taste_artists_taste_profile_id_artist_id_key" UNIQUE("taste_profile_id","artist_id"),
	CONSTRAINT "user_taste_artists_weight_check" CHECK ("user_taste_artists"."weight" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_taste_genres" (
	"id" text PRIMARY KEY NOT NULL,
	"taste_profile_id" text NOT NULL,
	"genre" text NOT NULL,
	"weight" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "user_taste_genres_taste_profile_id_genre_key" UNIQUE("taste_profile_id","genre"),
	CONSTRAINT "user_taste_genres_weight_check" CHECK ("user_taste_genres"."weight" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_taste_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"total_signal" double precision DEFAULT 0 NOT NULL,
	"last_decay_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_taste_profiles_oxy_user_id_key" UNIQUE("oxy_user_id"),
	CONSTRAINT "user_taste_profiles_total_signal_check" CHECK ("user_taste_profiles"."total_signal" >= 0)
);
--> statement-breakpoint
ALTER TABLE "listening_events" ADD CONSTRAINT "listening_events_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_events" ADD CONSTRAINT "listening_events_artist_id_catalog_entities_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."catalog_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_taste_artists" ADD CONSTRAINT "user_taste_artists_taste_profile_id_user_taste_profiles_id_fk" FOREIGN KEY ("taste_profile_id") REFERENCES "public"."user_taste_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_taste_artists" ADD CONSTRAINT "user_taste_artists_artist_id_catalog_entities_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."catalog_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_taste_genres" ADD CONSTRAINT "user_taste_genres_taste_profile_id_user_taste_profiles_id_fk" FOREIGN KEY ("taste_profile_id") REFERENCES "public"."user_taste_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_relations_kind_source_id_score_idx" ON "catalog_relations" USING btree ("kind","source_id","score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "listening_events_oxy_user_id_played_at_idx" ON "listening_events" USING btree ("oxy_user_id","played_at");--> statement-breakpoint
CREATE INDEX "listening_events_played_at_idx" ON "listening_events" USING btree ("played_at");--> statement-breakpoint
CREATE INDEX "listening_events_track_id_idx" ON "listening_events" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "listening_events_artist_id_idx" ON "listening_events" USING btree ("artist_id");--> statement-breakpoint
CREATE INDEX "notification_suppressions_expires_at_idx" ON "notification_suppressions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_taste_artists_artist_id_idx" ON "user_taste_artists" USING btree ("artist_id");