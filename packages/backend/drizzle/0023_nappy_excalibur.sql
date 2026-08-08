-- oxy:deploy-phase=post
-- NARROWING, four ways: an UPDATE that empties a column the previous image
-- reads, three ADD CONSTRAINT FOREIGN KEYs that verify every existing row, a
-- DROP COLUMN, and a CHECK that rejects any insert not naming exactly one
-- parent. Every one of them refuses writes the previous image makes, so this
-- half is only safe with the new image live. The `pre` half is `0022`.
--
-- THE ORDER OF THE FIRST STATEMENT IS LOAD-BEARING. Clearing `track_id` on the
-- two foreign arms has to precede the foreign keys, or
-- `track_keys_track_id_tracks_id_fk` validates a `user_uploads`/`episodes` id
-- against `tracks` and the migration fails on exactly the rows the split
-- exists for. It is the second half of the backfill `0022` opened, and it lives
-- here rather than there because it is the statement that would break an image
-- still resolving all three id spaces through `track_id`. Like its other half
-- it is DEFENSIVE — production data is not migrated, so it is expected to touch
-- zero rows — and it reads `kind` while the column is still present, which is
-- the other reason it comes before the DROP.
--
-- WHY THE FOREIGN KEYS ARE SAFE TO ADD AT ALL. `ADD CONSTRAINT ... FOREIGN KEY`
-- verifies every existing row; that is free on an empty table and a lock plus a
-- possible outright failure on a populated one. This runs inside the genesis
-- window (see `LAST_GENESIS_MIGRATION_TAG` in `src/db/migrate.ts`), where the
-- table is empty everywhere it is applied — the same property `0008` and `0010`
-- relied on. The markers still state what the statements WOULD do to a live
-- predecessor, because that is what they are for.
--
-- WHAT IT IS FOR. See `0022`'s header and `src/db/schema/trackKeys.ts`: three
-- real ON DELETE cascades in place of a polymorphic column plus a `kind`, so
-- the AES key a deleted parent leaves behind stops being something each caller
-- has to remember to delete.
UPDATE "track_keys" SET "track_id" = NULL WHERE "kind" <> 'track';--> statement-breakpoint
ALTER TABLE "track_keys" DROP CONSTRAINT "track_keys_kind_check";--> statement-breakpoint
ALTER TABLE "track_keys" ADD CONSTRAINT "track_keys_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_keys" ADD CONSTRAINT "track_keys_user_upload_id_user_uploads_id_fk" FOREIGN KEY ("user_upload_id") REFERENCES "public"."user_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_keys" ADD CONSTRAINT "track_keys_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_keys" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "track_keys" ADD CONSTRAINT "track_keys_user_upload_id_key" UNIQUE("user_upload_id");--> statement-breakpoint
ALTER TABLE "track_keys" ADD CONSTRAINT "track_keys_episode_id_key" UNIQUE("episode_id");--> statement-breakpoint
ALTER TABLE "track_keys" ADD CONSTRAINT "track_keys_one_parent_check" CHECK (num_nonnulls("track_keys"."track_id", "track_keys"."user_upload_id", "track_keys"."episode_id") = 1);
