-- oxy:deploy-phase=post
-- NARROWING-SHAPED, though semantically a no-op: it DROPs two CHECK constraints
-- on `user_settings` (created by 0014) and re-adds them without a redundant
-- `is null or …` branch. A Postgres CHECK passes when its expression evaluates
-- to NULL, so `x between 1 and 10` already admits the absent value the dropped
-- branch spelled out; both columns are nullable and both keep accepting NULL,
-- which `__tests__/gates.test.ts` asserts with an explicit accepted-NULL
-- fixture rather than leaving to this comment (Task 7 review, M3).
--
-- `post`, not `pre`, and NOT because the new constraint is stricter — it is
-- not. Between the DROP and the ADD there is a window with no constraint at
-- all, and an ADD CONSTRAINT is the shape that can reject a write the image
-- still serving considers legal. A statement of this shape belongs on the side
-- of the deploy where the new image is already the only writer, regardless of
-- what the expression happens to say; phasing on the STATEMENT rather than on
-- a case-by-case reading of its semantics is what keeps the rule mechanical.
--
-- Kept as its own file rather than folded into 0014: 0014 is already applied
-- (to `syra_dev` and CI), and editing an applied migration in place would
-- leave the declared schema and the ledger disagreeing — the exact divergence
-- migrate.ts exists to prevent. It is also the additive/narrowing split
-- migrate.ts's own COROLLARY requires: 0014 is `pre`, this is `post`, and
-- `drizzle-kit generate` would have emitted them as one file if the change had
-- been made in one pass.
ALTER TABLE "user_settings" DROP CONSTRAINT "user_settings_feed_diversity_max_consecutive_check";--> statement-breakpoint
ALTER TABLE "user_settings" DROP CONSTRAINT "user_settings_feed_quality_min_engagement_rate_check";--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_feed_diversity_max_consecutive_check" CHECK ("user_settings"."feed_diversity_max_consecutive_same_author" between 1 and 10);--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_feed_quality_min_engagement_rate_check" CHECK ("user_settings"."feed_quality_min_engagement_rate" between 0 and 1);