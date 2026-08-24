-- oxy:deploy-phase=pre
-- ADDITIVE ONLY. One new table, two columns with defaults, and a WIDENED check
-- constraint. Nothing is dropped, narrowed or renamed, so the PREVIOUS image
-- keeps serving unharmed: it never names `ai_generated` (both columns take
-- their default) and never writes `'alia'`.
--
-- The `podcast_sources_provider_check` DROP + ADD pair is how a CHECK is
-- widened; the pair is one migration file, so the window in which the
-- constraint does not exist is the window inside this migration and no image
-- can write through it. Widening also means every row already stored still
-- satisfies the new constraint, so the re-ADD validates without rewriting.
--
-- `episode_ingest_tickets` starts empty and is written only by the new draft
-- endpoint, which the previous image does not serve.

CREATE TABLE "episode_ingest_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"jti" text NOT NULL,
	"episode_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "episode_ingest_tickets_jti_key" UNIQUE("jti")
);
--> statement-breakpoint
ALTER TABLE "podcast_sources" DROP CONSTRAINT "podcast_sources_provider_check";--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "ai_generated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "podcasts" ADD COLUMN "ai_generated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "episode_ingest_tickets" ADD CONSTRAINT "episode_ingest_tickets_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "episode_ingest_tickets_episode_id_idx" ON "episode_ingest_tickets" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX "episode_ingest_tickets_expires_at_idx" ON "episode_ingest_tickets" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "podcast_sources" ADD CONSTRAINT "podcast_sources_provider_check" CHECK ("podcast_sources"."provider" in ('rss', 'syra', 'podcastindex', 'apple', 'alia'));