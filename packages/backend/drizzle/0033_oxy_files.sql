-- oxy:deploy-phase=pre
--
-- Images move into Oxy Files (OxyHQ/oxy ADR 0041). Additive only:
--  * image_assets gains the Oxy file it is stored as (oxy_file_id, oxy_variant)
--    and a serving status; s3_key becomes nullable because a row stored only in
--    Oxy has no bucket object. The previous image always writes s3_key and never
--    sees an Oxy-only row until it is replaced.
--  * houses/rooms/series gain an Oxy file id beside the legacy bucket URL.
--  * Four new, empty tables: the reference outbox, the nightly reconcile log,
--    the file-event dedupe log and the legacy-read counter.
-- The triggers that fill the outbox are 0034 (hand-written SQL).
CREATE TABLE "oxy_file_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"file_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oxy_file_reconcile_runs" (
	"entity_type" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"dry_run" boolean NOT NULL,
	"added" integer,
	"removed" integer,
	"unchanged" integer,
	"refused" integer,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_reconcile_runs_entity_type_check" CHECK ("oxy_file_reconcile_runs"."entity_type" in ('catalog_entity', 'album', 'track', 'user_upload', 'playlist', 'podcast', 'episode', 'house', 'room', 'series'))
);
--> statement-breakpoint
CREATE TABLE "oxy_file_reference_ops" (
	"file_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"op" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_until" timestamp with time zone,
	"last_error" text,
	"dead_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_reference_ops_file_id_entity_type_entity_id_pk" PRIMARY KEY("file_id","entity_type","entity_id"),
	CONSTRAINT "oxy_file_reference_ops_op_check" CHECK ("oxy_file_reference_ops"."op" in ('add', 'remove')),
	CONSTRAINT "oxy_file_reference_ops_entity_type_check" CHECK ("oxy_file_reference_ops"."entity_type" in ('catalog_entity', 'album', 'track', 'user_upload', 'playlist', 'podcast', 'episode', 'house', 'room', 'series')),
	CONSTRAINT "oxy_file_reference_ops_attempts_check" CHECK ("oxy_file_reference_ops"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "oxy_files_legacy_reads" (
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"reads" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_files_legacy_reads_day_kind_pk" PRIMARY KEY("day","kind"),
	CONSTRAINT "oxy_files_legacy_reads_kind_check" CHECK ("oxy_files_legacy_reads"."kind" in ('image_asset', 'house_avatar', 'house_cover', 'room_stream_image', 'series_cover')),
	CONSTRAINT "oxy_files_legacy_reads_reads_check" CHECK ("oxy_files_legacy_reads"."reads" >= 0)
);
--> statement-breakpoint
ALTER TABLE "image_assets" ALTER COLUMN "s3_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "image_assets" ADD COLUMN "oxy_file_id" text;--> statement-breakpoint
ALTER TABLE "image_assets" ADD COLUMN "oxy_variant" text;--> statement-breakpoint
ALTER TABLE "image_assets" ADD COLUMN "serving_status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "houses" ADD COLUMN "avatar_file_id" text;--> statement-breakpoint
ALTER TABLE "houses" ADD COLUMN "cover_image_file_id" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "stream_image_file_id" text;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "cover_image_file_id" text;--> statement-breakpoint
CREATE INDEX "oxy_file_events_received_at_idx" ON "oxy_file_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "oxy_file_reference_ops_due_idx" ON "oxy_file_reference_ops" USING btree ("next_attempt_at") WHERE "oxy_file_reference_ops"."dead_at" is null;--> statement-breakpoint
CREATE INDEX "oxy_file_reference_ops_dead_at_idx" ON "oxy_file_reference_ops" USING btree ("dead_at");--> statement-breakpoint
CREATE INDEX "catalog_entities_image_suggestions_gin" ON "catalog_entities" USING gin ("image_suggestions" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "image_assets_oxy_file_id_idx" ON "image_assets" USING btree ("oxy_file_id");--> statement-breakpoint
ALTER TABLE "image_assets" ADD CONSTRAINT "image_assets_storage_check" CHECK ("image_assets"."s3_key" is not null or "image_assets"."oxy_file_id" is not null);--> statement-breakpoint
ALTER TABLE "image_assets" ADD CONSTRAINT "image_assets_oxy_variant_check" CHECK ("image_assets"."oxy_variant" is null or ("image_assets"."oxy_file_id" is not null and "image_assets"."oxy_variant" in ('w96', 'w128', 'thumb', 'w320', 'w640', 'w1280', 'w2048')));--> statement-breakpoint
ALTER TABLE "image_assets" ADD CONSTRAINT "image_assets_serving_status_check" CHECK ("image_assets"."serving_status" in ('active', 'unavailable', 'blocked', 'missing'));