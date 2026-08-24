-- oxy:deploy-phase=pre
-- ADDITIVE ONLY: one column with a DEFAULT, plus its CHECK. Nothing is dropped,
-- narrowed or renamed, so the PREVIOUS image keeps serving unharmed while this
-- is applied — it never names `visibility`, and every row it writes takes the
-- default.
--
-- `DEFAULT 'public'` is the whole safety of this migration. Every existing show
-- is world-readable today, and the RSS import path writes shows mirrored from
-- public feeds without naming this column, so any other default would hide the
-- mirrored catalogue the moment this ran.
--
-- Cost: `ADD COLUMN ... DEFAULT` is metadata-only on Postgres 11+, and the
-- CHECK is validated with a single scan of `podcasts` under an ACCESS EXCLUSIVE
-- lock. That table is small (thousands of rows), so the scan is milliseconds;
-- it is stated here because the lock, not the column, is what a much larger
-- table would have to worry about.
ALTER TABLE "podcasts" ADD COLUMN "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "podcasts" ADD CONSTRAINT "podcasts_visibility_check" CHECK ("podcasts"."visibility" in ('private', 'unlisted', 'public'));
