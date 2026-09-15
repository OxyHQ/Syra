-- oxy:deploy-phase=pre
-- ADDITIVE ONLY: one new index. Nothing is dropped, narrowed or renamed, so
-- the PREVIOUS image keeps serving unharmed while this is applied.
--
-- `findExistingCatalogImageSet` (`imageAssetService.ts`) queries this column
-- on every catalog image mirror attempt, before ever downloading, to reuse a
-- prior mirror of the same source URL from any entity — without this index
-- that lookup is a full table scan of `image_assets` on every call.
CREATE INDEX "image_assets_catalog_source_url_hash_idx" ON "image_assets" USING btree ("catalog_source_url_hash");