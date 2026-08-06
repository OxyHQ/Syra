-- oxy:deploy-phase=pre
-- Purely additive: 18 new tables, nothing dropped, renamed or narrowed on
-- anything that already exists. Safe to apply while the previous image (which
-- has never heard of these tables) is still serving.
CREATE TABLE "album_genres" (
	"id" text PRIMARY KEY NOT NULL,
	"album_id" text NOT NULL,
	"genre_id" text NOT NULL,
	CONSTRAINT "album_genres_album_id_genre_id_key" UNIQUE("album_id","genre_id")
);
--> statement-breakpoint
CREATE TABLE "album_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"album_id" text NOT NULL,
	"position" integer NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"fields" text[] DEFAULT array[]::text[] NOT NULL,
	CONSTRAINT "album_sources_album_id_position_key" UNIQUE("album_id","position"),
	CONSTRAINT "album_sources_provider_check" CHECK ("album_sources"."provider" in ('upload', 'cc', 'musicbrainz', 'wikidata', 'wikimedia-commons', 'cover-art-archive', 'discogs')),
	CONSTRAINT "album_sources_position_check" CHECK ("album_sources"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "albums" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"artist_id" text NOT NULL,
	"artist_name" text NOT NULL,
	"release_date" text NOT NULL,
	"cover_art_id" text NOT NULL,
	"cover_art_sizes_small_id" text,
	"cover_art_sizes_medium_id" text,
	"cover_art_sizes_large_id" text,
	"cover_art_sizes_xlarge_id" text,
	"cover_art_sizes_xxlarge_id" text,
	"cover_art_sizes_original_id" text,
	"cover_art_licence_licence" text,
	"cover_art_licence_licence_url" text,
	"cover_art_licence_attribution" text,
	"cover_art_licence_source_url" text,
	"total_tracks" integer DEFAULT 0 NOT NULL,
	"total_discs" integer,
	"total_duration" double precision DEFAULT 0 NOT NULL,
	"type" text DEFAULT 'album' NOT NULL,
	"label" text,
	"catalog_number" text,
	"media" text,
	"release_country" text,
	"original_release_date" text,
	"copyright" text,
	"upc" text,
	"popularity" integer DEFAULT 0 NOT NULL,
	"play_count" integer DEFAULT 0 NOT NULL,
	"favorite_count" integer DEFAULT 0 NOT NULL,
	"repost_count" integer DEFAULT 0 NOT NULL,
	"is_explicit" boolean DEFAULT false NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"primary_color" text,
	"secondary_color" text,
	"source" text,
	"external_isrc" text,
	"external_musicbrainz_release_id" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || artist_name)) STORED,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "albums_upc_key" UNIQUE("upc"),
	CONSTRAINT "albums_external_musicbrainz_release_id_key" UNIQUE("external_musicbrainz_release_id"),
	CONSTRAINT "albums_type_check" CHECK ("albums"."type" in ('album', 'single', 'ep', 'compilation')),
	CONSTRAINT "albums_source_check" CHECK ("albums"."source" is null or "albums"."source" in ('upload', 'cc')),
	CONSTRAINT "albums_popularity_check" CHECK ("albums"."popularity" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "catalog_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"name_key" text,
	"image_id" text,
	"image_sizes_small_id" text,
	"image_sizes_medium_id" text,
	"image_sizes_large_id" text,
	"image_sizes_xlarge_id" text,
	"image_sizes_xxlarge_id" text,
	"image_sizes_original_id" text,
	"image_licence_licence" text,
	"image_licence_licence_url" text,
	"image_licence_attribution" text,
	"image_licence_source_url" text,
	"primary_color" text,
	"secondary_color" text,
	"bio" text,
	"links_website" text,
	"links_instagram" text,
	"links_x" text,
	"links_youtube" text,
	"links_discogs" text,
	"links_wikidata" text,
	"links_wikipedia" text,
	"links_bandcamp" text,
	"links_soundcloud" text,
	"popularity" integer DEFAULT 0 NOT NULL,
	"owner_oxy_user_id" text,
	"claimable" boolean,
	"claimed_by_oxy_user_id" text,
	"linked_oxy_user_id" text,
	"href" text,
	"images" jsonb,
	"genres" text[],
	"verified" boolean DEFAULT false,
	"stats_followers" integer DEFAULT 0,
	"stats_albums" integer DEFAULT 0,
	"stats_tracks" integer DEFAULT 0,
	"stats_total_plays" integer DEFAULT 0,
	"stats_monthly_listeners" integer DEFAULT 0,
	"strike_count" integer DEFAULT 0,
	"uploads_disabled" boolean DEFAULT false,
	"last_strike_at" timestamp with time zone,
	"terminated" boolean DEFAULT false,
	"terminated_at" timestamp with time zone,
	"termination_reason" text,
	"source" text,
	"external_isrc" text,
	"external_musicbrainz_artist_id" text,
	"external_isni" text,
	"external_ipi" text,
	"external_wikidata_id" text,
	"external_discogs_artist_id" text,
	"country" text,
	"sort_name" text,
	"disambiguation" text,
	"artist_type" text,
	"active_from" text,
	"active_until" text,
	"aliases" text[],
	"labels" text[],
	"origin" text DEFAULT 'registered',
	"accepts_contributions" boolean DEFAULT false,
	"image_suggestions" jsonb,
	"linked_artist_id" text,
	"img" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', name)) STORED,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_entities_linked_oxy_user_id_key" UNIQUE("linked_oxy_user_id"),
	CONSTRAINT "catalog_entities_href_key" UNIQUE("href"),
	CONSTRAINT "catalog_entities_external_musicbrainz_artist_id_key" UNIQUE("external_musicbrainz_artist_id"),
	CONSTRAINT "catalog_entities_type_check" CHECK ("catalog_entities"."type" in ('artist', 'person')),
	CONSTRAINT "catalog_entities_linked_artist_id_check" CHECK ("catalog_entities"."linked_artist_id" is null or "catalog_entities"."type" = 'person'),
	CONSTRAINT "catalog_entities_source_check" CHECK ("catalog_entities"."source" is null or "catalog_entities"."source" in ('upload', 'cc')),
	CONSTRAINT "catalog_entities_artist_type_check" CHECK ("catalog_entities"."artist_type" is null or "catalog_entities"."artist_type" in ('person', 'group', 'orchestra', 'choir', 'character', 'other')),
	CONSTRAINT "catalog_entities_origin_check" CHECK ("catalog_entities"."origin" is null or "catalog_entities"."origin" in ('registered', 'contributed')),
	CONSTRAINT "catalog_entities_strike_count_check" CHECK ("catalog_entities"."strike_count" is null or "catalog_entities"."strike_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "catalog_entity_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"catalog_entity_id" text NOT NULL,
	"position" integer NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"fields" text[] DEFAULT array[]::text[] NOT NULL,
	CONSTRAINT "catalog_entity_sources_catalog_entity_id_position_key" UNIQUE("catalog_entity_id","position"),
	CONSTRAINT "catalog_entity_sources_provider_check" CHECK ("catalog_entity_sources"."provider" in ('upload', 'cc', 'musicbrainz', 'wikidata', 'wikimedia-commons', 'cover-art-archive', 'discogs')),
	CONSTRAINT "catalog_entity_sources_position_check" CHECK ("catalog_entity_sources"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "catalog_entity_strikes" (
	"id" text PRIMARY KEY NOT NULL,
	"catalog_entity_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"track_id" text
);
--> statement-breakpoint
CREATE TABLE "discogs_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"discogs_release_id" text NOT NULL,
	"barcodes" text[] DEFAULT array[]::text[] NOT NULL,
	"title" text NOT NULL,
	"artist_names" text[] DEFAULT array[]::text[] NOT NULL,
	"labels" text[] DEFAULT array[]::text[] NOT NULL,
	"catalog_numbers" text[] DEFAULT array[]::text[] NOT NULL,
	"formats" text[] DEFAULT array[]::text[] NOT NULL,
	"country_code" text,
	"released" text,
	"credits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "discogs_releases_discogs_release_id_key" UNIQUE("discogs_release_id")
);
--> statement-breakpoint
CREATE TABLE "image_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"s3_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"owner_type" text NOT NULL,
	"uploaded_by" text,
	"primary_color" text,
	"secondary_color" text,
	"catalog_provider" text,
	"catalog_entity_type" text,
	"catalog_external_id" text,
	"catalog_size" text,
	"catalog_source_url_hash" text,
	"catalog_source_content_hash" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "image_assets_s3_key_key" UNIQUE("s3_key"),
	CONSTRAINT "image_assets_owner_type_check" CHECK ("image_assets"."owner_type" in ('upload', 'artist', 'track', 'album', 'playlist', 'link', 'podcast', 'episode')),
	CONSTRAINT "image_assets_catalog_provider_check" CHECK ("image_assets"."catalog_provider" is null or "image_assets"."catalog_provider" in ('upload', 'cc', 'rss', 'syra')),
	CONSTRAINT "image_assets_catalog_entity_type_check" CHECK ("image_assets"."catalog_entity_type" is null or "image_assets"."catalog_entity_type" in ('artist', 'track', 'album', 'playlist', 'podcast', 'episode'))
);
--> statement-breakpoint
CREATE TABLE "isrc_registry" (
	"id" text PRIMARY KEY NOT NULL,
	"isrc" text NOT NULL,
	"recording_mbid" text NOT NULL,
	"title" text NOT NULL,
	"artist_credit" text NOT NULL,
	"artist_credit_name_key" text NOT NULL,
	"length_ms" integer,
	"release_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "isrc_registry_isrc_key" UNIQUE("isrc")
);
--> statement-breakpoint
CREATE TABLE "lyrics" (
	"id" text PRIMARY KEY NOT NULL,
	"track_id" text NOT NULL,
	"synced" boolean DEFAULT false NOT NULL,
	"plain" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "lyrics_track_id_key" UNIQUE("track_id")
);
--> statement-breakpoint
CREATE TABLE "lyrics_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"lyrics_id" text NOT NULL,
	"position" integer NOT NULL,
	"time_ms" integer NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "lyrics_lines_lyrics_id_position_key" UNIQUE("lyrics_id","position"),
	CONSTRAINT "lyrics_lines_position_check" CHECK ("lyrics_lines"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "musicbrainz_artist_urls" (
	"id" text PRIMARY KEY NOT NULL,
	"musicbrainz_artist_id" text NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "musicbrainz_artist_urls_musicbrainz_artist_id_position_key" UNIQUE("musicbrainz_artist_id","position"),
	CONSTRAINT "musicbrainz_artist_urls_position_check" CHECK ("musicbrainz_artist_urls"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "musicbrainz_artists" (
	"id" text PRIMARY KEY NOT NULL,
	"mbid" text NOT NULL,
	"name" text NOT NULL,
	"sort_name" text NOT NULL,
	"name_key" text NOT NULL,
	"disambiguation" text,
	"artist_type" text,
	"area_name" text,
	"country_code" text,
	"begin_date" text,
	"end_date" text,
	"ended" boolean DEFAULT false NOT NULL,
	"aliases" text[] DEFAULT array[]::text[] NOT NULL,
	"isni" text,
	"ipi" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "musicbrainz_artists_mbid_key" UNIQUE("mbid"),
	CONSTRAINT "musicbrainz_artists_artist_type_check" CHECK ("musicbrainz_artists"."artist_type" is null or "musicbrainz_artists"."artist_type" in ('person', 'group', 'orchestra', 'choir', 'character', 'other'))
);
--> statement-breakpoint
CREATE TABLE "track_credits" (
	"id" text PRIMARY KEY NOT NULL,
	"track_id" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"name_key" text NOT NULL,
	CONSTRAINT "track_credits_track_id_position_key" UNIQUE("track_id","position"),
	CONSTRAINT "track_credits_position_check" CHECK ("track_credits"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "track_fingerprints" (
	"id" text PRIMARY KEY NOT NULL,
	"track_id" text NOT NULL,
	"fingerprint" integer[] NOT NULL,
	"fingerprint_duration_sec" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "track_fingerprints_track_id_key" UNIQUE("track_id")
);
--> statement-breakpoint
CREATE TABLE "track_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"track_id" text NOT NULL,
	"key_hex" text NOT NULL,
	"key_uri" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "track_keys_track_id_key" UNIQUE("track_id"),
	CONSTRAINT "track_keys_kind_check" CHECK ("track_keys"."kind" in ('track', 'user_upload', 'episode'))
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"artist_id" text NOT NULL,
	"artist_name" text NOT NULL,
	"album_id" text,
	"album_name" text,
	"duration" double precision NOT NULL,
	"track_number" integer,
	"disc_number" integer,
	"total_tracks" integer,
	"total_discs" integer,
	"original_release_date" text,
	"catalog_number" text,
	"label" text,
	"media" text,
	"release_country" text,
	"replay_gain_track_db" double precision,
	"replay_gain_album_db" double precision,
	"replay_gain_track_peak" double precision,
	"comment" text,
	"audio_source_url" text,
	"audio_source_format" text,
	"audio_source_bitrate" integer,
	"audio_source_duration" double precision,
	"cover_art_id" text,
	"cover_art_sizes_small_id" text,
	"cover_art_sizes_medium_id" text,
	"cover_art_sizes_large_id" text,
	"cover_art_sizes_xlarge_id" text,
	"cover_art_sizes_xxlarge_id" text,
	"cover_art_sizes_original_id" text,
	"metadata_bpm" double precision,
	"metadata_key" text,
	"metadata_explicit" boolean,
	"metadata_language" text,
	"metadata_copyright" text,
	"metadata_publisher" text,
	"metadata_genre" text[],
	"genre" text,
	"mood" text,
	"tags" text[] DEFAULT array[]::text[] NOT NULL,
	"release_date" timestamp with time zone,
	"is_explicit" boolean DEFAULT false NOT NULL,
	"popularity" integer DEFAULT 0 NOT NULL,
	"play_count" integer DEFAULT 0 NOT NULL,
	"favorite_count" integer DEFAULT 0 NOT NULL,
	"repost_count" integer DEFAULT 0 NOT NULL,
	"primary_color" text,
	"secondary_color" text,
	"is_available" boolean DEFAULT true NOT NULL,
	"copyright_removed" boolean DEFAULT false NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_reason" text,
	"removed_by" text,
	"copyright_report_id" text,
	"source" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"external_isrc" text,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"loudness_lufs" double precision,
	"hls_master_key" text,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sha256" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || artist_name)) STORED,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tracks_external_isrc_key" UNIQUE("external_isrc"),
	CONSTRAINT "tracks_source_check" CHECK ("tracks"."source" in ('upload', 'cc')),
	CONSTRAINT "tracks_status_check" CHECK ("tracks"."status" in ('processing', 'ready', 'failed')),
	CONSTRAINT "tracks_audio_source_format_check" CHECK ("tracks"."audio_source_format" is null or "tracks"."audio_source_format" in ('mp3', 'flac', 'ogg', 'm4a', 'wav')),
	CONSTRAINT "tracks_popularity_check" CHECK ("tracks"."popularity" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "genres" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "genres_name_key" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "album_genres" ADD CONSTRAINT "album_genres_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_genres" ADD CONSTRAINT "album_genres_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."genres"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_sources" ADD CONSTRAINT "album_sources_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_artist_id_catalog_entities_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."catalog_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_cover_art_id_image_assets_id_fk" FOREIGN KEY ("cover_art_id") REFERENCES "public"."image_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_cover_art_sizes_small_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_small_id") REFERENCES "public"."image_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_cover_art_sizes_medium_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_medium_id") REFERENCES "public"."image_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_cover_art_sizes_large_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_large_id") REFERENCES "public"."image_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_cover_art_sizes_xlarge_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_xlarge_id") REFERENCES "public"."image_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_cover_art_sizes_xxlarge_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_xxlarge_id") REFERENCES "public"."image_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_cover_art_sizes_original_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_original_id") REFERENCES "public"."image_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_entities" ADD CONSTRAINT "catalog_entities_image_id_image_assets_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_entities" ADD CONSTRAINT "catalog_entities_image_sizes_small_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_small_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_entities" ADD CONSTRAINT "catalog_entities_image_sizes_medium_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_medium_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_entities" ADD CONSTRAINT "catalog_entities_image_sizes_large_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_large_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_entities" ADD CONSTRAINT "catalog_entities_image_sizes_xlarge_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_xlarge_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_entities" ADD CONSTRAINT "catalog_entities_image_sizes_xxlarge_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_xxlarge_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_entities" ADD CONSTRAINT "catalog_entities_image_sizes_original_id_image_assets_id_fk" FOREIGN KEY ("image_sizes_original_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_entities" ADD CONSTRAINT "catalog_entities_linked_artist_id_catalog_entities_id_fk" FOREIGN KEY ("linked_artist_id") REFERENCES "public"."catalog_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_entity_sources" ADD CONSTRAINT "catalog_entity_sources_catalog_entity_id_catalog_entities_id_fk" FOREIGN KEY ("catalog_entity_id") REFERENCES "public"."catalog_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_entity_strikes" ADD CONSTRAINT "catalog_entity_strikes_catalog_entity_id_catalog_entities_id_fk" FOREIGN KEY ("catalog_entity_id") REFERENCES "public"."catalog_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_entity_strikes" ADD CONSTRAINT "catalog_entity_strikes_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lyrics" ADD CONSTRAINT "lyrics_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lyrics_lines" ADD CONSTRAINT "lyrics_lines_lyrics_id_lyrics_id_fk" FOREIGN KEY ("lyrics_id") REFERENCES "public"."lyrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "musicbrainz_artist_urls" ADD CONSTRAINT "musicbrainz_artist_urls_musicbrainz_artist_id_musicbrainz_artists_id_fk" FOREIGN KEY ("musicbrainz_artist_id") REFERENCES "public"."musicbrainz_artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_credits" ADD CONSTRAINT "track_credits_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_fingerprints" ADD CONSTRAINT "track_fingerprints_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_artist_id_catalog_entities_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."catalog_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_cover_art_id_image_assets_id_fk" FOREIGN KEY ("cover_art_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_cover_art_sizes_small_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_small_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_cover_art_sizes_medium_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_medium_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_cover_art_sizes_large_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_large_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_cover_art_sizes_xlarge_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_xlarge_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_cover_art_sizes_xxlarge_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_xxlarge_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_cover_art_sizes_original_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_original_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "album_genres_genre_id_idx" ON "album_genres" USING btree ("genre_id");--> statement-breakpoint
CREATE INDEX "albums_artist_id_release_date_idx" ON "albums" USING btree ("artist_id","release_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "albums_popularity_idx" ON "albums" USING btree ("popularity" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "albums_release_date_idx" ON "albums" USING btree ("release_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "albums_external_isrc_idx" ON "albums" USING btree ("external_isrc");--> statement-breakpoint
CREATE INDEX "albums_search_gin" ON "albums" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_entities_artist_name_key_key" ON "catalog_entities" USING btree ("name_key") WHERE "catalog_entities"."type" = 'artist';--> statement-breakpoint
CREATE INDEX "catalog_entities_type_name_key_idx" ON "catalog_entities" USING btree ("type","name_key");--> statement-breakpoint
CREATE INDEX "catalog_entities_popularity_idx" ON "catalog_entities" USING btree ("popularity" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "catalog_entities_owner_oxy_user_id_idx" ON "catalog_entities" USING btree ("owner_oxy_user_id");--> statement-breakpoint
CREATE INDEX "catalog_entities_stats_followers_idx" ON "catalog_entities" USING btree ("stats_followers" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "catalog_entities_verified_popularity_idx" ON "catalog_entities" USING btree ("verified","popularity" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "catalog_entities_linked_artist_id_idx" ON "catalog_entities" USING btree ("linked_artist_id");--> statement-breakpoint
CREATE INDEX "catalog_entities_search_gin" ON "catalog_entities" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "catalog_entity_strikes_catalog_entity_id_idx" ON "catalog_entity_strikes" USING btree ("catalog_entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "discogs_releases_barcodes_gin" ON "discogs_releases" USING gin ("barcodes");--> statement-breakpoint
CREATE INDEX "image_assets_uploaded_by_idx" ON "image_assets" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "image_assets_catalog_lookup_idx" ON "image_assets" USING btree ("catalog_provider","catalog_entity_type","catalog_external_id","catalog_size");--> statement-breakpoint
CREATE INDEX "image_assets_catalog_source_content_hash_idx" ON "image_assets" USING btree ("catalog_source_content_hash");--> statement-breakpoint
CREATE INDEX "isrc_registry_recording_mbid_idx" ON "isrc_registry" USING btree ("recording_mbid");--> statement-breakpoint
CREATE INDEX "isrc_registry_artist_credit_name_key_idx" ON "isrc_registry" USING btree ("artist_credit_name_key");--> statement-breakpoint
CREATE INDEX "musicbrainz_artists_name_key_idx" ON "musicbrainz_artists" USING btree ("name_key");--> statement-breakpoint
CREATE INDEX "track_credits_name_key_idx" ON "track_credits" USING btree ("name_key");--> statement-breakpoint
CREATE INDEX "track_fingerprints_duration_idx" ON "track_fingerprints" USING btree ("fingerprint_duration_sec");--> statement-breakpoint
CREATE INDEX "tracks_artist_id_album_id_idx" ON "tracks" USING btree ("artist_id","album_id");--> statement-breakpoint
CREATE INDEX "tracks_popularity_idx" ON "tracks" USING btree ("popularity" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tracks_play_count_idx" ON "tracks" USING btree ("play_count" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tracks_created_at_idx" ON "tracks" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tracks_sha256_idx" ON "tracks" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "tracks_genre_idx" ON "tracks" USING btree ("genre");--> statement-breakpoint
CREATE INDEX "tracks_tags_gin" ON "tracks" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "tracks_search_gin" ON "tracks" USING gin ("search_vector");