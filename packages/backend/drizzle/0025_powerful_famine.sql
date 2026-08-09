-- oxy:deploy-phase=pre
-- ADDITIVE ONLY: one nullable column and its foreign key. Nothing is dropped,
-- narrowed or renamed, so the PREVIOUS image keeps serving unharmed while this
-- applies — which is what `pre` means.
--
-- The column exists because a registry-resolved upload finally supplies a
-- high-confidence artist identity (ISRC / acoustic fingerprint -> MusicBrainz).
-- It stays NULLABLE because a credit whose name came from a file tag has no
-- identity behind it, and `ON DELETE SET NULL` because deleting an artist row
-- must not delete the credit: the person was still on the record.

ALTER TABLE "track_credits" ADD COLUMN "catalog_entity_id" text;--> statement-breakpoint
ALTER TABLE "track_credits" ADD CONSTRAINT "track_credits_catalog_entity_id_catalog_entities_id_fk" FOREIGN KEY ("catalog_entity_id") REFERENCES "public"."catalog_entities"("id") ON DELETE set null ON UPDATE no action;