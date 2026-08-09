-- oxy:deploy-phase=pre
-- ADDITIVE ONLY: one partial index. Nothing is dropped, narrowed or renamed, so
-- the PREVIOUS image keeps serving unharmed while this is applied.
--
-- It answers "is this artist credited on anything?", the probe that decides
-- whether a featured guest — who owns no track of their own — has an artist
-- page at all. That probe runs once per artist row on every artist listing, so
-- without the index each one seq-scans `track_credits`.

CREATE INDEX "track_credits_catalog_entity_id_idx" ON "track_credits" USING btree ("catalog_entity_id") WHERE "track_credits"."catalog_entity_id" is not null;
