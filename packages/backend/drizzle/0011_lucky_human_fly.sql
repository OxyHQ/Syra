-- oxy:deploy-phase=pre
-- ADDITIVE ONLY. Eight brand-new tables (Task 6, the rooms and live vertical),
-- the eight foreign keys among them, and seventeen indexes on them. Nothing
-- here touches a table that existed before this migration: every ADD CONSTRAINT
-- below targets a table CREATE'd in this same file, so none of them can reject
-- a write the image still serving considers legal — that image knows nothing
-- about any of these tables.
--
-- That is what makes this `pre` rather than `post`, and it is a different
-- situation from 0004, which migrate.ts calls out as the shape to avoid: 0004
-- was ten additive CREATE TABLEs dragged onto the `post` side by ONE trailing
-- ADD CONSTRAINT against a pre-existing table. There is no such statement here,
-- so no hand-split into two files is needed. `drizzle-kit generate` produced
-- this file unmodified apart from this header.
--
-- `rooms.topic_id` is deliberately absent: `models/Room.ts:224` declares
-- `ref: 'Topic'` against a model that does not exist in this repo, and nothing
-- writes the field. See schema/rooms.ts's file-level doc comment for the full
-- evidence behind dropping rather than carrying it.
CREATE TABLE "house_members" (
	"id" text PRIMARY KEY NOT NULL,
	"house_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "house_members_house_id_oxy_user_id_key" UNIQUE("house_id","oxy_user_id"),
	CONSTRAINT "house_members_role_check" CHECK ("house_members"."role" in ('owner', 'admin', 'host', 'member'))
);
--> statement-breakpoint
CREATE TABLE "houses" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"avatar" text,
	"cover_image" text,
	"created_by" text NOT NULL,
	"visibility_discovery" text DEFAULT 'listed' NOT NULL,
	"visibility_rooms" text DEFAULT 'anyone' NOT NULL,
	"visibility_join" text DEFAULT 'invite' NOT NULL,
	"tags" text[] DEFAULT array[]::text[] NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', name || ' ' || coalesce(description, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "houses_visibility_discovery_check" CHECK ("houses"."visibility_discovery" in ('listed', 'unlisted', 'hidden')),
	CONSTRAINT "houses_visibility_rooms_check" CHECK ("houses"."visibility_rooms" in ('anyone', 'members')),
	CONSTRAINT "houses_visibility_join_check" CHECK ("houses"."visibility_join" in ('anyone', 'invite')),
	CONSTRAINT "houses_name_length_check" CHECK (char_length("houses"."name") <= 100),
	CONSTRAINT "houses_description_length_check" CHECK ("houses"."description" is null or char_length("houses"."description") <= 500)
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text,
	"room_title" text NOT NULL,
	"host" text NOT NULL,
	"status" text DEFAULT 'recording' NOT NULL,
	"egress_id" text NOT NULL,
	"object_key" text NOT NULL,
	"file_size" integer,
	"duration_ms" integer,
	"started_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"access" text DEFAULT 'public' NOT NULL,
	"participant_ids" text[] DEFAULT array[]::text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "recordings_egress_id_key" UNIQUE("egress_id"),
	CONSTRAINT "recordings_status_check" CHECK ("recordings"."status" in ('recording', 'processing', 'ready', 'failed', 'deleted')),
	CONSTRAINT "recordings_access_check" CHECK ("recordings"."access" in ('public', 'participants')),
	CONSTRAINT "recordings_file_size_check" CHECK ("recordings"."file_size" is null or "recordings"."file_size" >= 0),
	CONSTRAINT "recordings_duration_ms_check" CHECK ("recordings"."duration_ms" is null or "recordings"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "room_media_queue_items" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"syra_podcast_id" text,
	"episode_id" text,
	"track_id" text,
	CONSTRAINT "room_media_queue_items_room_id_position_key" UNIQUE("room_id","position"),
	CONSTRAINT "room_media_queue_items_kind_check" CHECK ("room_media_queue_items"."kind" in ('podcast', 'track')),
	CONSTRAINT "room_media_queue_items_position_check" CHECK ("room_media_queue_items"."position" >= 0),
	CONSTRAINT "room_media_queue_items_kind_ids_check" CHECK (("room_media_queue_items"."kind" = 'podcast' and "room_media_queue_items"."episode_id" is not null and "room_media_queue_items"."track_id" is null)
          or ("room_media_queue_items"."kind" = 'track' and "room_media_queue_items"."track_id" is not null and "room_media_queue_items"."episode_id" is null and "room_media_queue_items"."syra_podcast_id" is null))
);
--> statement-breakpoint
CREATE TABLE "room_user_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"live_visibility" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "room_user_preferences_oxy_user_id_key" UNIQUE("oxy_user_id"),
	CONSTRAINT "room_user_preferences_live_visibility_check" CHECK ("room_user_preferences"."live_visibility" in ('active', 'speaking'))
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"owner_type" text DEFAULT 'profile' NOT NULL,
	"host" text NOT NULL,
	"house_id" text,
	"created_by_admin" text,
	"type" text DEFAULT 'talk' NOT NULL,
	"broadcast_kind" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"scheduled_start" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"speaker_permission" text DEFAULT 'invited' NOT NULL,
	"participants" text[] DEFAULT array[]::text[] NOT NULL,
	"speakers" text[] DEFAULT array[]::text[] NOT NULL,
	"max_participants" integer DEFAULT 100 NOT NULL,
	"topic" text,
	"tags" text[] DEFAULT array[]::text[] NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"series_id" text,
	"stats_peak_listeners" integer DEFAULT 0 NOT NULL,
	"stats_total_joined" integer DEFAULT 0 NOT NULL,
	"recording_enabled" boolean DEFAULT true NOT NULL,
	"recording_egress_id" text,
	"active_ingress_id" text,
	"active_stream_url" text,
	"stream_title" text,
	"stream_image" text,
	"stream_description" text,
	"rtmp_url" text,
	"rtmp_stream_key" text,
	"stream_started_at" timestamp with time zone,
	"stream_duration_sec" double precision,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "rooms_owner_type_check" CHECK ("rooms"."owner_type" in ('profile', 'house', 'agora')),
	CONSTRAINT "rooms_type_check" CHECK ("rooms"."type" in ('talk', 'stage', 'broadcast')),
	CONSTRAINT "rooms_broadcast_kind_check" CHECK ("rooms"."broadcast_kind" is null or "rooms"."broadcast_kind" in ('user', 'agora')),
	CONSTRAINT "rooms_status_check" CHECK ("rooms"."status" in ('scheduled', 'live', 'ended')),
	CONSTRAINT "rooms_speaker_permission_check" CHECK ("rooms"."speaker_permission" in ('everyone', 'followers', 'invited')),
	CONSTRAINT "rooms_max_participants_check" CHECK ("rooms"."max_participants" between 1 and 10000),
	CONSTRAINT "rooms_stats_peak_listeners_check" CHECK ("rooms"."stats_peak_listeners" >= 0),
	CONSTRAINT "rooms_stats_total_joined_check" CHECK ("rooms"."stats_total_joined" >= 0),
	CONSTRAINT "rooms_stream_duration_sec_check" CHECK ("rooms"."stream_duration_sec" is null or "rooms"."stream_duration_sec" >= 0),
	CONSTRAINT "rooms_title_length_check" CHECK (char_length("rooms"."title") <= 200),
	CONSTRAINT "rooms_description_length_check" CHECK ("rooms"."description" is null or char_length("rooms"."description") <= 500),
	CONSTRAINT "rooms_topic_length_check" CHECK ("rooms"."topic" is null or char_length("rooms"."topic") <= 100),
	CONSTRAINT "rooms_stream_title_length_check" CHECK ("rooms"."stream_title" is null or char_length("rooms"."stream_title") <= 200),
	CONSTRAINT "rooms_stream_description_length_check" CHECK ("rooms"."stream_description" is null or char_length("rooms"."stream_description") <= 500)
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"cover_image" text,
	"house_id" text,
	"created_by" text NOT NULL,
	"recurrence_type" text NOT NULL,
	"recurrence_day_of_week" integer,
	"recurrence_day_of_month" integer,
	"recurrence_time" text NOT NULL,
	"recurrence_timezone" text DEFAULT 'UTC' NOT NULL,
	"room_template_title_pattern" text NOT NULL,
	"room_template_type" text DEFAULT 'talk' NOT NULL,
	"room_template_description" text,
	"room_template_max_participants" integer DEFAULT 100 NOT NULL,
	"room_template_speaker_permission" text DEFAULT 'invited' NOT NULL,
	"room_template_tags" text[] DEFAULT array[]::text[] NOT NULL,
	"next_episode_number" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "series_recurrence_type_check" CHECK ("series"."recurrence_type" in ('daily', 'weekly', 'biweekly', 'monthly')),
	CONSTRAINT "series_recurrence_day_of_week_check" CHECK ("series"."recurrence_day_of_week" is null or "series"."recurrence_day_of_week" between 0 and 6),
	CONSTRAINT "series_recurrence_day_of_month_check" CHECK ("series"."recurrence_day_of_month" is null or "series"."recurrence_day_of_month" between 1 and 31),
	CONSTRAINT "series_recurrence_time_check" CHECK ("series"."recurrence_time" ~ '^[0-9]{2}:[0-9]{2}$'),
	CONSTRAINT "series_room_template_type_check" CHECK ("series"."room_template_type" in ('talk', 'stage', 'broadcast')),
	CONSTRAINT "series_room_template_max_participants_check" CHECK ("series"."room_template_max_participants" between 1 and 10000),
	CONSTRAINT "series_room_template_speaker_permission_check" CHECK ("series"."room_template_speaker_permission" in ('everyone', 'followers', 'invited')),
	CONSTRAINT "series_next_episode_number_check" CHECK ("series"."next_episode_number" >= 1),
	CONSTRAINT "series_title_length_check" CHECK (char_length("series"."title") <= 200),
	CONSTRAINT "series_description_length_check" CHECK ("series"."description" is null or char_length("series"."description") <= 500),
	CONSTRAINT "series_room_template_title_pattern_length_check" CHECK (char_length("series"."room_template_title_pattern") <= 200),
	CONSTRAINT "series_room_template_description_length_check" CHECK ("series"."room_template_description" is null or char_length("series"."room_template_description") <= 500)
);
--> statement-breakpoint
CREATE TABLE "series_episodes" (
	"id" text PRIMARY KEY NOT NULL,
	"series_id" text NOT NULL,
	"position" integer NOT NULL,
	"room_id" text,
	"scheduled_start" timestamp with time zone NOT NULL,
	"episode_number" integer NOT NULL,
	CONSTRAINT "series_episodes_series_id_position_key" UNIQUE("series_id","position"),
	CONSTRAINT "series_episodes_position_check" CHECK ("series_episodes"."position" >= 0),
	CONSTRAINT "series_episodes_episode_number_check" CHECK ("series_episodes"."episode_number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "house_members" ADD CONSTRAINT "house_members_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_media_queue_items" ADD CONSTRAINT "room_media_queue_items_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_episodes" ADD CONSTRAINT "series_episodes_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_episodes" ADD CONSTRAINT "series_episodes_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "house_members_oxy_user_id_idx" ON "house_members" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "houses_visibility_discovery_created_at_idx" ON "houses" USING btree ("visibility_discovery","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "houses_visibility_rooms_idx" ON "houses" USING btree ("visibility_rooms");--> statement-breakpoint
CREATE INDEX "houses_search_gin" ON "houses" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "recordings_ready_public_created_at_idx" ON "recordings" USING btree ("created_at" DESC NULLS LAST) WHERE "recordings"."status" = 'ready' and "recordings"."access" = 'public';--> statement-breakpoint
CREATE INDEX "recordings_ready_host_idx" ON "recordings" USING btree ("host") WHERE "recordings"."status" = 'ready';--> statement-breakpoint
CREATE INDEX "recordings_room_id_status_created_at_idx" ON "recordings" USING btree ("room_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recordings_participant_ids_gin" ON "recordings" USING gin ("participant_ids");--> statement-breakpoint
CREATE INDEX "rooms_status_created_at_idx" ON "rooms" USING btree ("status","created_at" DESC NULLS LAST) WHERE "rooms"."archived" = false;--> statement-breakpoint
CREATE INDEX "rooms_house_id_status_created_at_idx" ON "rooms" USING btree ("house_id","status","created_at" DESC NULLS LAST) WHERE "rooms"."archived" = false;--> statement-breakpoint
CREATE INDEX "rooms_host_status_created_at_idx" ON "rooms" USING btree ("host","status","created_at" DESC NULLS LAST) WHERE "rooms"."archived" = false;--> statement-breakpoint
CREATE INDEX "rooms_type_status_created_at_idx" ON "rooms" USING btree ("type","status","created_at" DESC NULLS LAST) WHERE "rooms"."archived" = false;--> statement-breakpoint
CREATE INDEX "rooms_owner_type_type_status_created_at_idx" ON "rooms" USING btree ("owner_type","type","status","created_at" DESC NULLS LAST) WHERE "rooms"."archived" = false;--> statement-breakpoint
CREATE INDEX "rooms_active_ingress_id_idx" ON "rooms" USING btree ("active_ingress_id") WHERE "rooms"."active_ingress_id" is not null;--> statement-breakpoint
CREATE INDEX "rooms_series_id_idx" ON "rooms" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "series_house_id_active_created_at_idx" ON "series" USING btree ("house_id","created_at" DESC NULLS LAST) WHERE "series"."is_active" = true;--> statement-breakpoint
CREATE INDEX "series_episodes_room_id_idx" ON "series_episodes" USING btree ("room_id");