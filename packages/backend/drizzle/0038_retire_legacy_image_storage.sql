-- oxy:deploy-phase=post
--
-- The last of Syra's legacy image storage (OxyHQ/oxy ADR 0043): every image is
-- an Oxy file, and the bucket's image prefixes were deleted on 2026-10-21
-- (docs/runbooks/oxy-files-images.md). `post` because every statement narrows:
-- the image it replaces still reads `image_assets.s3_key`, the house and series
-- URL columns, and writes `oxy_files_legacy_reads`.
--
-- Verified against production before this was written (2026-10-21): 0 of
-- 505,085 `image_assets` rows had an `s3_key` or lacked an `oxy_file_id`, every
-- row was `active` (none `missing`), and no house or series held a URL image.
-- `rooms.stream_image` stays: it is a stream's own thumbnail link, not storage.
--
-- `oxy_file_id` SET NOT NULL scans `image_assets` once under its lock; the table
-- is not a hot one and the scan is of half a million narrow rows.

ALTER TABLE "oxy_files_legacy_reads" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "oxy_files_legacy_reads" CASCADE;--> statement-breakpoint
ALTER TABLE "image_assets" DROP CONSTRAINT "image_assets_s3_key_key";--> statement-breakpoint
ALTER TABLE "image_assets" DROP CONSTRAINT "image_assets_storage_check";--> statement-breakpoint
ALTER TABLE "image_assets" DROP CONSTRAINT "image_assets_serving_status_check";--> statement-breakpoint
ALTER TABLE "image_assets" ALTER COLUMN "oxy_file_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "image_assets" DROP COLUMN "s3_key";--> statement-breakpoint
ALTER TABLE "houses" DROP COLUMN "avatar";--> statement-breakpoint
ALTER TABLE "houses" DROP COLUMN "cover_image";--> statement-breakpoint
ALTER TABLE "series" DROP COLUMN "cover_image";--> statement-breakpoint
ALTER TABLE "image_assets" ADD CONSTRAINT "image_assets_serving_status_check" CHECK ("image_assets"."serving_status" in ('active', 'unavailable', 'blocked'));