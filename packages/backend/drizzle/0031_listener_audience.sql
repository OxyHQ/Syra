-- oxy:deploy-phase=pre
-- Additive public audience timestamp; existing clients retain their stored count.
ALTER TABLE "catalog_entities" ADD COLUMN "stats_monthly_listeners_computed_at" timestamp with time zone;