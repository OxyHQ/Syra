-- oxy:deploy-phase=pre
--
-- Audio moves into Oxy Files (OxyHQ/oxy ADR 0043, stage 4c). Additive only:
-- nullable columns naming each audio-bearing row's Oxy file, the
-- `oxy_audio_files` table of what Syra knows about those files, their indexes,
-- and the reference outbox's entity-type CHECKs WIDENED to the four audio
-- entity types (the old values all still pass, so the code already running
-- keeps writing). Nothing reads the new columns until `OXY_AUDIO` leaves
-- `legacy` or the operator runs `migrate:audio-to-oxy`.
CREATE TABLE "oxy_audio_files" (
	"file_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_oxy_user_id" text,
	"sha256" text,
	"mime" text NOT NULL,
	"size_bytes" bigint,
	"hls_ready_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_audio_files_status_check" CHECK ("oxy_audio_files"."status" in ('active', 'unavailable', 'blocked')),
	CONSTRAINT "oxy_audio_files_owner_kind_check" CHECK ("oxy_audio_files"."owner_kind" in ('application', 'account')),
	CONSTRAINT "oxy_audio_files_owner_check" CHECK (("oxy_audio_files"."owner_kind" = 'account') = ("oxy_audio_files"."owner_oxy_user_id" is not null)),
	CONSTRAINT "oxy_audio_files_size_check" CHECK ("oxy_audio_files"."size_bytes" is null or "oxy_audio_files"."size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "oxy_file_reconcile_runs" DROP CONSTRAINT "oxy_file_reconcile_runs_entity_type_check";--> statement-breakpoint
ALTER TABLE "oxy_file_reference_ops" DROP CONSTRAINT "oxy_file_reference_ops_entity_type_check";--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "audio_file_id" text;--> statement-breakpoint
ALTER TABLE "user_uploads" ADD COLUMN "audio_file_id" text;--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "audio_file_id" text;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "oxy_file_id" text;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "oxy_recording_target_id" text;--> statement-breakpoint
CREATE INDEX "tracks_audio_file_id_idx" ON "tracks" USING btree ("audio_file_id") WHERE "tracks"."audio_file_id" is not null;--> statement-breakpoint
CREATE INDEX "user_uploads_audio_file_id_idx" ON "user_uploads" USING btree ("audio_file_id") WHERE "user_uploads"."audio_file_id" is not null;--> statement-breakpoint
CREATE INDEX "episodes_audio_file_id_idx" ON "episodes" USING btree ("audio_file_id") WHERE "episodes"."audio_file_id" is not null;--> statement-breakpoint
CREATE INDEX "recordings_oxy_file_id_idx" ON "recordings" USING btree ("oxy_file_id") WHERE "recordings"."oxy_file_id" is not null;--> statement-breakpoint
ALTER TABLE "oxy_file_reconcile_runs" ADD CONSTRAINT "oxy_file_reconcile_runs_entity_type_check" CHECK ("oxy_file_reconcile_runs"."entity_type" in ('catalog_entity', 'album', 'track', 'user_upload', 'playlist', 'podcast', 'episode', 'house', 'room', 'series', 'track_audio', 'user_upload_audio', 'episode_audio', 'recording'));--> statement-breakpoint
ALTER TABLE "oxy_file_reference_ops" ADD CONSTRAINT "oxy_file_reference_ops_entity_type_check" CHECK ("oxy_file_reference_ops"."entity_type" in ('catalog_entity', 'album', 'track', 'user_upload', 'playlist', 'podcast', 'episode', 'house', 'room', 'series', 'track_audio', 'user_upload_audio', 'episode_audio', 'recording'));