-- oxy:deploy-phase=pre
-- Purely additive: one new index, nothing dropped, renamed or narrowed.
-- Correct against the previous image and the arriving one alike (a review
-- fix for podcasts.ts's I3 — see task-4-review.md).
CREATE INDEX "podcasts_inactive_idx" ON "podcasts" USING btree ("id") WHERE "podcasts"."status" <> 'active';