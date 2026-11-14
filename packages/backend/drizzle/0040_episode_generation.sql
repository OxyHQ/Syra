-- oxy:deploy-phase=pre
-- Generated episodes (docs/podcast-generation.md): two new, empty tables that
-- nothing reads yet. `pre`, because the image that follows is the first thing
-- that writes them. The foreign keys to `podcasts` and `episodes` validate
-- instantly against empty tables.
CREATE TABLE "episode_generations" (
	"episode_id" text PRIMARY KEY NOT NULL,
	"podcast_id" text NOT NULL,
	"requested_by_oxy_user_id" text NOT NULL,
	"topic" text,
	"requested_title" text,
	"notes" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recap" text,
	"error" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "episode_generations_status_check" CHECK ("episode_generations"."status" in ('queued', 'writing', 'recording', 'assembling', 'publishing', 'completed', 'failed')),
	CONSTRAINT "episode_generations_progress_check" CHECK ("episode_generations"."progress" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "podcast_generation_profiles" (
	"podcast_id" text PRIMARY KEY NOT NULL,
	"brief" text NOT NULL,
	"format" text DEFAULT 'podcast' NOT NULL,
	"speech_model" text NOT NULL,
	"speakers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "podcast_generation_profiles_format_check" CHECK ("podcast_generation_profiles"."format" in ('podcast', 'news', 'debate', 'interview', 'explainer'))
);
--> statement-breakpoint
ALTER TABLE "episode_generations" ADD CONSTRAINT "episode_generations_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode_generations" ADD CONSTRAINT "episode_generations_podcast_id_podcasts_id_fk" FOREIGN KEY ("podcast_id") REFERENCES "public"."podcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcast_generation_profiles" ADD CONSTRAINT "podcast_generation_profiles_podcast_id_podcasts_id_fk" FOREIGN KEY ("podcast_id") REFERENCES "public"."podcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "episode_generations_podcast_created_at_idx" ON "episode_generations" USING btree ("podcast_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "episode_generations_requester_idempotency_key" ON "episode_generations" USING btree ("requested_by_oxy_user_id","idempotency_key") WHERE "episode_generations"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "episode_generations_requester_created_at_idx" ON "episode_generations" USING btree ("requested_by_oxy_user_id","created_at" DESC NULLS LAST);