-- oxy:deploy-phase=post
-- The ten new tables and their own constraints/indexes are additive on their
-- own, but the final statement — ALTER TABLE user_podcast_subscriptions ADD
-- CONSTRAINT ..._podcast_id_podcasts_id_fk — narrows what's permitted on an
-- EXISTING table (Task 3): a row with an arbitrary podcast_id string,
-- previously accepted, is now rejected unless it matches a real podcasts.id.
-- Same reasoning as 0002_wealthy_stepford_cuckoos's narrowing CHECK — the
-- whole file goes on the `post` side.
CREATE TABLE "episode_hls_renditions" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"position" integer NOT NULL,
	"manifest_key" text NOT NULL,
	"bitrate_kbps" integer NOT NULL,
	"encrypted" boolean NOT NULL,
	CONSTRAINT "episode_hls_renditions_episode_id_position_key" UNIQUE("episode_id","position"),
	CONSTRAINT "episode_hls_renditions_position_check" CHECK ("episode_hls_renditions"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "episode_persons" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"group" text,
	"img" text,
	"href" text,
	"linked_oxy_user_id" text,
	CONSTRAINT "episode_persons_episode_id_position_key" UNIQUE("episode_id","position"),
	CONSTRAINT "episode_persons_position_check" CHECK ("episode_persons"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "episode_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"episode_id" text NOT NULL,
	"position_sec" double precision DEFAULT 0 NOT NULL,
	"duration_sec" double precision DEFAULT 0 NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "episode_progress_oxy_user_id_episode_id_key" UNIQUE("oxy_user_id","episode_id")
);
--> statement-breakpoint
CREATE TABLE "episode_transcripts" (
	"id" text PRIMARY KEY NOT NULL,
	"episode_id" text NOT NULL,
	"position" integer NOT NULL,
	"url" text NOT NULL,
	"type" text NOT NULL,
	"language" text,
	CONSTRAINT "episode_transcripts_episode_id_position_key" UNIQUE("episode_id","position"),
	CONSTRAINT "episode_transcripts_position_check" CHECK ("episode_transcripts"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" text PRIMARY KEY NOT NULL,
	"podcast_id" text NOT NULL,
	"podcast_title" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"summary" text,
	"guid" text NOT NULL,
	"enclosure_url" text,
	"enclosure_type" text,
	"enclosure_length" integer,
	"duration" double precision DEFAULT 0 NOT NULL,
	"pub_date" timestamp with time zone NOT NULL,
	"season" integer,
	"episode_number" integer,
	"episode_type" text DEFAULT 'full' NOT NULL,
	"image_id" text,
	"image_sizes_small_id" text,
	"image_sizes_medium_id" text,
	"image_sizes_large_id" text,
	"image_sizes_xlarge_id" text,
	"image_sizes_xxlarge_id" text,
	"image_sizes_original_id" text,
	"primary_color" text,
	"secondary_color" text,
	"image_source_url" text,
	"explicit" boolean DEFAULT false NOT NULL,
	"chapters_url" text,
	"chapters_type" text,
	"source" text NOT NULL,
	"cache_status" text,
	"cache_object_key" text,
	"cache_hls_master_key" text,
	"cache_cached_at" timestamp with time zone,
	"audio_source_url" text,
	"audio_source_format" text,
	"audio_source_bitrate" integer,
	"audio_source_duration" double precision,
	"hls_master_key" text,
	"play_count" integer DEFAULT 0 NOT NULL,
	"popularity" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', title)) STORED,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "episodes_podcast_id_guid_key" UNIQUE("podcast_id","guid"),
	CONSTRAINT "episodes_episode_type_check" CHECK ("episodes"."episode_type" in ('full', 'trailer', 'bonus')),
	CONSTRAINT "episodes_source_check" CHECK ("episodes"."source" in ('rss', 'syra')),
	CONSTRAINT "episodes_status_check" CHECK ("episodes"."status" in ('ready', 'processing', 'failed', 'unavailable')),
	CONSTRAINT "episodes_cache_status_check" CHECK ("episodes"."cache_status" is null or "episodes"."cache_status" in ('none', 'cached', 'hls')),
	CONSTRAINT "episodes_audio_source_format_check" CHECK ("episodes"."audio_source_format" is null or "episodes"."audio_source_format" in ('mp3', 'flac', 'ogg', 'm4a', 'wav')),
	CONSTRAINT "episodes_popularity_check" CHECK ("episodes"."popularity" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "podcast_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"podcast_id" text NOT NULL,
	"genre_id" text NOT NULL,
	CONSTRAINT "podcast_categories_podcast_id_genre_id_key" UNIQUE("podcast_id","genre_id")
);
--> statement-breakpoint
CREATE TABLE "podcast_funding" (
	"id" text PRIMARY KEY NOT NULL,
	"podcast_id" text NOT NULL,
	"position" integer NOT NULL,
	"url" text NOT NULL,
	"message" text,
	CONSTRAINT "podcast_funding_podcast_id_position_key" UNIQUE("podcast_id","position"),
	CONSTRAINT "podcast_funding_position_check" CHECK ("podcast_funding"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "podcast_persons" (
	"id" text PRIMARY KEY NOT NULL,
	"podcast_id" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"group" text,
	"img" text,
	"href" text,
	"linked_oxy_user_id" text,
	CONSTRAINT "podcast_persons_podcast_id_position_key" UNIQUE("podcast_id","position"),
	CONSTRAINT "podcast_persons_position_check" CHECK ("podcast_persons"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "podcast_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"podcast_id" text NOT NULL,
	"position" integer NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"imported_at" text NOT NULL,
	"fields" text[] DEFAULT array[]::text[] NOT NULL,
	CONSTRAINT "podcast_sources_podcast_id_position_key" UNIQUE("podcast_id","position"),
	CONSTRAINT "podcast_sources_provider_check" CHECK ("podcast_sources"."provider" in ('rss', 'syra', 'podcastindex', 'apple')),
	CONSTRAINT "podcast_sources_position_check" CHECK ("podcast_sources"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "podcasts" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"author" text,
	"image_id" text,
	"image_sizes_small_id" text,
	"image_sizes_medium_id" text,
	"image_sizes_large_id" text,
	"image_sizes_xlarge_id" text,
	"image_sizes_xxlarge_id" text,
	"image_sizes_original_id" text,
	"primary_color" text,
	"secondary_color" text,
	"image_source_url" text,
	"language" text,
	"explicit" boolean DEFAULT false NOT NULL,
	"link" text,
	"type" text DEFAULT 'episodic' NOT NULL,
	"feed_url" text,
	"podcast_guid" text,
	"podcast_index_id" integer,
	"apple_collection_id" integer,
	"source" text NOT NULL,
	"owner_oxy_user_id" text,
	"claimable" boolean,
	"claimed_by_oxy_user_id" text,
	"linked_artist_id" text,
	"last_refreshed_at" timestamp with time zone,
	"refresh_interval_min" integer DEFAULT 60 NOT NULL,
	"etag" text,
	"last_modified" text,
	"episode_count" integer DEFAULT 0 NOT NULL,
	"last_episode_at" timestamp with time zone,
	"needs_deep_import" boolean DEFAULT false NOT NULL,
	"popularity" integer DEFAULT 0 NOT NULL,
	"subscriber_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"value" jsonb,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || coalesce(author, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "podcasts_feed_url_key" UNIQUE("feed_url"),
	CONSTRAINT "podcasts_podcast_guid_key" UNIQUE("podcast_guid"),
	CONSTRAINT "podcasts_type_check" CHECK ("podcasts"."type" in ('episodic', 'serial')),
	CONSTRAINT "podcasts_source_check" CHECK ("podcasts"."source" in ('rss', 'syra')),
	CONSTRAINT "podcasts_status_check" CHECK ("podcasts"."status" in ('active', 'unavailable', 'removed')),
	CONSTRAINT "podcasts_popularity_check" CHECK ("podcasts"."popularity" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "episode_hls_renditions" ADD CONSTRAINT "episode_hls_renditions_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode_persons" ADD CONSTRAINT "episode_persons_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode_progress" ADD CONSTRAINT "episode_progress_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode_transcripts" ADD CONSTRAINT "episode_transcripts_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_podcast_id_podcasts_id_fk" FOREIGN KEY ("podcast_id") REFERENCES "public"."podcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_image_id_image_assets_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_image_sizes_small_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_small_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_image_sizes_medium_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_medium_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_image_sizes_large_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_large_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_image_sizes_xlarge_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_xlarge_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_image_sizes_xxlarge_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_xxlarge_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_image_sizes_original_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_original_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcast_categories" ADD CONSTRAINT "podcast_categories_podcast_id_podcasts_id_fk" FOREIGN KEY ("podcast_id") REFERENCES "public"."podcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcast_categories" ADD CONSTRAINT "podcast_categories_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."genres"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcast_funding" ADD CONSTRAINT "podcast_funding_podcast_id_podcasts_id_fk" FOREIGN KEY ("podcast_id") REFERENCES "public"."podcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcast_persons" ADD CONSTRAINT "podcast_persons_podcast_id_podcasts_id_fk" FOREIGN KEY ("podcast_id") REFERENCES "public"."podcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcast_sources" ADD CONSTRAINT "podcast_sources_podcast_id_podcasts_id_fk" FOREIGN KEY ("podcast_id") REFERENCES "public"."podcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcasts" ADD CONSTRAINT "podcasts_image_id_image_assets_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcasts" ADD CONSTRAINT "podcasts_image_sizes_small_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_small_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcasts" ADD CONSTRAINT "podcasts_image_sizes_medium_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_medium_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcasts" ADD CONSTRAINT "podcasts_image_sizes_large_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_large_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcasts" ADD CONSTRAINT "podcasts_image_sizes_xlarge_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_xlarge_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcasts" ADD CONSTRAINT "podcasts_image_sizes_xxlarge_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_xxlarge_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcasts" ADD CONSTRAINT "podcasts_image_sizes_original_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_original_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcasts" ADD CONSTRAINT "podcasts_linked_artist_id_catalog_entities_id_fk" FOREIGN KEY ("linked_artist_id") REFERENCES "public"."catalog_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "episode_persons_linked_oxy_user_id_idx" ON "episode_persons" USING btree ("linked_oxy_user_id");--> statement-breakpoint
CREATE INDEX "episode_persons_href_idx" ON "episode_persons" USING btree ("href");--> statement-breakpoint
CREATE INDEX "episode_progress_episode_id_idx" ON "episode_progress" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX "episode_progress_oxy_user_id_updated_at_idx" ON "episode_progress" USING btree ("oxy_user_id","updated_at" DESC NULLS LAST) WHERE "episode_progress"."completed" = false;--> statement-breakpoint
CREATE INDEX "episodes_podcast_id_pub_date_idx" ON "episodes" USING btree ("podcast_id","pub_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "episodes_ready_popularity_idx" ON "episodes" USING btree ("popularity" DESC NULLS LAST,"pub_date" DESC NULLS LAST) WHERE "episodes"."status" = 'ready';--> statement-breakpoint
CREATE INDEX "episodes_search_gin" ON "episodes" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "podcast_categories_genre_id_idx" ON "podcast_categories" USING btree ("genre_id");--> statement-breakpoint
CREATE INDEX "podcast_persons_linked_oxy_user_id_idx" ON "podcast_persons" USING btree ("linked_oxy_user_id");--> statement-breakpoint
CREATE INDEX "podcast_persons_href_idx" ON "podcast_persons" USING btree ("href");--> statement-breakpoint
CREATE INDEX "podcasts_linked_artist_id_idx" ON "podcasts" USING btree ("linked_artist_id");--> statement-breakpoint
CREATE INDEX "podcasts_owner_oxy_user_id_created_at_idx" ON "podcasts" USING btree ("owner_oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "podcasts_active_popularity_idx" ON "podcasts" USING btree ("popularity" DESC NULLS LAST,"subscriber_count" DESC NULLS LAST,"last_episode_at" DESC NULLS LAST) WHERE "podcasts"."status" = 'active';--> statement-breakpoint
CREATE INDEX "podcasts_active_last_episode_at_idx" ON "podcasts" USING btree ("last_episode_at" DESC NULLS LAST) WHERE "podcasts"."status" = 'active';--> statement-breakpoint
CREATE INDEX "podcasts_rss_active_subscriber_count_idx" ON "podcasts" USING btree ("subscriber_count" DESC NULLS LAST,"popularity" DESC NULLS LAST) WHERE "podcasts"."status" = 'active' and "podcasts"."source" = 'rss';--> statement-breakpoint
CREATE INDEX "podcasts_search_gin" ON "podcasts" USING gin ("search_vector");--> statement-breakpoint
ALTER TABLE "user_podcast_subscriptions" ADD CONSTRAINT "user_podcast_subscriptions_podcast_id_podcasts_id_fk" FOREIGN KEY ("podcast_id") REFERENCES "public"."podcasts"("id") ON DELETE cascade ON UPDATE no action;