-- oxy:deploy-phase=post
--
-- The episode ingest-ticket lane goes: `POST /api/podcasts/:id/episodes/draft`
-- and `POST /api/podcasts/episodes/:id/ingest` (with `/ingest/upload` and
-- `/ingest/abandon`) existed only so Alia could publish the shows it generated
-- into Syra. Syra generates episodes itself now and writes their audio
-- directly (docs/podcast-generation.md), so nothing mints or redeems a ticket.
--
-- Production, counted read-only on 2026-11-14: `episode_ingest_tickets` 0 rows,
-- and no episode left at `processing` with no audio.
--
-- `post`, because both statements take something away from the image this
-- rollout replaces: until it drains it still serves the draft route, which
-- inserts a ticket row, and still accepts `aliaSeriesId`, which writes the
-- `'alia'` provider the narrowed CHECK refuses. 0041 already deleted the two
-- `'alia'` rows, so the re-added CHECK validates against what is left; a row
-- written in between would make it fail loudly rather than pass.
--
-- There is no `pre` half for the table: the new image never reads or writes
-- it, and its only tie to the rest of the schema is a cascade from `episodes`
-- that keeps working until the drop.

ALTER TABLE "episode_ingest_tickets" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "episode_ingest_tickets" CASCADE;--> statement-breakpoint
ALTER TABLE "podcast_sources" DROP CONSTRAINT "podcast_sources_provider_check";--> statement-breakpoint
ALTER TABLE "podcast_sources" ADD CONSTRAINT "podcast_sources_provider_check" CHECK ("podcast_sources"."provider" in ('rss', 'syra', 'podcastindex', 'apple'));