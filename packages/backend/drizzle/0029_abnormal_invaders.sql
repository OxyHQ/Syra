-- oxy:deploy-phase=pre
-- ADDITIVE ONLY: one index. Nothing is dropped, narrowed or renamed, so the
-- PREVIOUS image keeps serving unharmed while this is applied — it simply does
-- not use it.
--
-- It supports `episodesByShowQuery`'s new ordering (`episode_number desc nulls
-- last, pub_date desc nulls last`). Measured on 2,000 episodes of one show:
-- without it the planner top-N heapsorts every episode of the show at cost
-- 1937.01 / 108 buffers; with it the scan streams and stops at the page, cost
-- 63.13 / 5 buffers. The cost stops being a function of the show's size.
--
-- Deliberately NON-PARTIAL, exactly like `episodes_podcast_id_pub_date_idx`: a
-- `status = 'ready'` predicate would stop serving the owner's own
-- unpublished-episode view, which is the one view that sees every status.

CREATE INDEX "episodes_podcast_id_episode_number_pub_date_idx" ON "episodes" USING btree ("podcast_id","episode_number" DESC NULLS LAST,"pub_date" DESC NULLS LAST);