-- oxy:deploy-phase=pre
-- Additive: two nullable columns with no default, plus DROP NOT NULL on an
-- existing one. An image that does not know about `user_upload_id`/`episode_id`
-- keeps inserting successfully while this runs, and relaxing a NOT NULL cannot
-- reject a write that was legal before it.
--
-- WHAT IT IS FOR. `track_keys.track_id` is polymorphic across three id spaces
-- (`tracks`, `user_uploads`, `episodes`) with a `kind` column naming which one
-- applies. Postgres has no conditional foreign key, so that column can carry no
-- reference at all — and the absence is a live orphan, not a theoretical one:
-- with nothing cascading, every caller deleting a parent has to delete the key
-- itself, and `services/uploads/expirySweeper.ts`, which runs unattended every
-- hour, never has. This pair of migrations splits the column into one per id
-- space so all three can carry a real ON DELETE cascade; see
-- `src/db/schema/trackKeys.ts` for the whole reasoning.
--
-- THE BACKFILL IS SPLIT ACROSS THE PAIR, AND THAT SPLIT IS THE POINT. Copying
-- `track_id` into the arm its `kind` names is additive — every row keeps its
-- `track_id`, so the previous image goes on resolving all three id spaces
-- through the column it knows. CLEARING `track_id` on the two foreign arms is
-- what would break that image, so it is not here; it opens the `post` half.
--
-- THE BACKFILL IS DEFENSIVE, NOT LOAD-BEARING. Production data is not migrated
-- (the port's Global Constraints) and Postgres starts empty, so these two
-- statements are expected to touch zero rows everywhere they run. They exist so
-- the pair is correct against a database that HAS rows — a developer's, a
-- rehearsal's — rather than only against the empty one it will ever meet here.
ALTER TABLE "track_keys" ALTER COLUMN "track_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "track_keys" ADD COLUMN "user_upload_id" text;--> statement-breakpoint
ALTER TABLE "track_keys" ADD COLUMN "episode_id" text;--> statement-breakpoint
UPDATE "track_keys" SET "user_upload_id" = "track_id" WHERE "kind" = 'user_upload';--> statement-breakpoint
UPDATE "track_keys" SET "episode_id" = "track_id" WHERE "kind" = 'episode';
