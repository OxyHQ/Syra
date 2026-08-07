-- oxy:deploy-phase=pre
-- Additive: five nullable-free columns with a server-side DEFAULT, so an image
-- that does not know about them keeps inserting successfully while this runs.
--
-- WHAT IT IS FOR. Each of the five junction tables replaces one ORDERED Mongo
-- array on `UserLibrary`, and `$addToSet` appended — so the array position was
-- the record of when a membership was added. Two surfaces read it:
-- `services/radio/radioSeed.ts` seeds a station from the freshest likes and
-- `controllers/library.controller.ts` returns each list in insertion order.
-- A junction table has no intrinsic order, and the uuid v7 primary key is
-- time-sortable only by accident of how ids are minted. See
-- `src/db/schema/library.ts`'s file-level doc comment.
--
-- The DEFAULT backfills every existing row to the same instant, which would
-- make "the freshest likes" arbitrary among them. That is not a concern here
-- and the reason is a project constraint rather than luck: the plan's Global
-- Constraints say production data is NOT migrated, so these five tables are
-- empty when this runs and every row that will ever exist gets its own real
-- timestamp on insert. A project that did backfill would have to order by
-- something else for the rows it copied.
ALTER TABLE "user_followed_artists" ADD COLUMN "created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL;--> statement-breakpoint
ALTER TABLE "user_liked_tracks" ADD COLUMN "created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL;--> statement-breakpoint
ALTER TABLE "user_podcast_subscriptions" ADD COLUMN "created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL;--> statement-breakpoint
ALTER TABLE "user_saved_albums" ADD COLUMN "created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL;--> statement-breakpoint
ALTER TABLE "user_saved_playlists" ADD COLUMN "created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL;