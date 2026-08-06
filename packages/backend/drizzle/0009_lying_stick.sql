-- oxy:deploy-phase=pre
-- Purely additive: nine new tables (Task 5, schema/creators.ts) with their
-- own constraints and indexes, plus the foreign keys those tables declare on
-- already-existing parents (tracks, catalog_entities, image_assets). Nothing
-- is dropped, renamed or narrowed here, and no constraint is added to a table
-- an image already writes to — correct against the previous image and the
-- arriving one alike.
--
-- The one narrowing half of this task is the FK `tracks.copyright_report_id`
-- finally owes now that `copyright_reports` exists: an ADD CONSTRAINT on a
-- pre-existing table, which is a REAL narrowing and therefore lives in its
-- own `post` file (0010), not here. `drizzle-kit generate` would have emitted
-- both in one file if the schema change had been made in one pass; it was
-- deliberately made in two so each file carries one phase (see migrate.ts's
-- "A COROLLARY FOR EVERY MIGRATION AFTER THE BOUNDARY").
CREATE TABLE "artist_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"artist_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"evidence" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "artist_claims_status_check" CHECK ("artist_claims"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "artist_claims_evidence_length_check" CHECK (char_length("artist_claims"."evidence") <= 4000),
	CONSTRAINT "artist_claims_resolution_note_length_check" CHECK ("artist_claims"."resolution_note" is null or char_length("artist_claims"."resolution_note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "contribution_attestation_provenance_markers" (
	"id" text PRIMARY KEY NOT NULL,
	"contribution_attestation_id" text NOT NULL,
	"position" integer NOT NULL,
	"code" text NOT NULL,
	"weight" text NOT NULL,
	"detail" text,
	CONSTRAINT "contribution_attestation_provenance_markers_position_key" UNIQUE("contribution_attestation_id","position"),
	CONSTRAINT "contribution_attestation_provenance_markers_weight_check" CHECK ("contribution_attestation_provenance_markers"."weight" in ('low', 'medium', 'high', 'blocking')),
	CONSTRAINT "contribution_attestation_provenance_markers_position_check" CHECK ("contribution_attestation_provenance_markers"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "contribution_attestations" (
	"id" text PRIMARY KEY NOT NULL,
	"track_id" text NOT NULL,
	"uploader_oxy_user_id" text NOT NULL,
	"statement" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"provenance_report_score" double precision,
	"provenance_report_verdict" text,
	"raw_tags_format" text,
	"raw_tags_json" text,
	"raw_tags_truncated" boolean,
	"raw_tags_original_byte_length" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "contribution_attestations_track_id_key" UNIQUE("track_id"),
	CONSTRAINT "contribution_attestations_provenance_report_verdict_check" CHECK ("contribution_attestations"."provenance_report_verdict" is null or "contribution_attestations"."provenance_report_verdict" in ('clean', 'suspect', 'commercial'))
);
--> statement-breakpoint
CREATE TABLE "contributor_standings" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"strike_count" integer DEFAULT 0 NOT NULL,
	"last_strike_at" timestamp with time zone,
	"uploads_disabled" boolean DEFAULT false NOT NULL,
	"terminated" boolean DEFAULT false NOT NULL,
	"terminated_at" timestamp with time zone,
	"termination_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "contributor_standings_oxy_user_id_key" UNIQUE("oxy_user_id"),
	CONSTRAINT "contributor_standings_strike_count_check" CHECK ("contributor_standings"."strike_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "contributor_strikes" (
	"id" text PRIMARY KEY NOT NULL,
	"contributor_standing_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"track_id" text
);
--> statement-breakpoint
CREATE TABLE "copyright_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"track_id" text NOT NULL,
	"artist_id" text NOT NULL,
	"reporter_oxy_user_id" text,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "copyright_reports_status_check" CHECK ("copyright_reports"."status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "user_upload_hls_renditions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_upload_id" text NOT NULL,
	"position" integer NOT NULL,
	"manifest_key" text NOT NULL,
	"bitrate_kbps" integer NOT NULL,
	"encrypted" boolean NOT NULL,
	CONSTRAINT "user_upload_hls_renditions_user_upload_id_position_key" UNIQUE("user_upload_id","position"),
	CONSTRAINT "user_upload_hls_renditions_position_check" CHECK ("user_upload_hls_renditions"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_upload_provenance_markers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_upload_id" text NOT NULL,
	"position" integer NOT NULL,
	"code" text NOT NULL,
	"weight" text NOT NULL,
	"detail" text,
	CONSTRAINT "user_upload_provenance_markers_user_upload_id_position_key" UNIQUE("user_upload_id","position"),
	CONSTRAINT "user_upload_provenance_markers_weight_check" CHECK ("user_upload_provenance_markers"."weight" in ('low', 'medium', 'high', 'blocking')),
	CONSTRAINT "user_upload_provenance_markers_position_check" CHECK ("user_upload_provenance_markers"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_oxy_user_id" text NOT NULL,
	"title" text NOT NULL,
	"artist_name" text,
	"album_artist_name" text,
	"album_name" text,
	"album_key" text,
	"track_number" integer,
	"disc_number" integer,
	"year" integer,
	"genres" text[] DEFAULT array[]::text[] NOT NULL,
	"lyrics" jsonb,
	"total_tracks" integer,
	"total_discs" integer,
	"original_release_date" text,
	"catalog_number" text,
	"label" text,
	"media" text,
	"release_country" text,
	"replay_gain_track_db" double precision,
	"replay_gain_album_db" double precision,
	"replay_gain_track_peak" double precision,
	"comment" text,
	"credits" jsonb,
	"duration" double precision NOT NULL,
	"codec" text,
	"bitrate_kbps" integer,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"fingerprint" integer[] DEFAULT array[]::integer[] NOT NULL,
	"fingerprint_duration_sec" double precision,
	"cover_art_id" text,
	"cover_art_sizes_small_id" text,
	"cover_art_sizes_medium_id" text,
	"cover_art_sizes_large_id" text,
	"cover_art_sizes_xlarge_id" text,
	"cover_art_sizes_xxlarge_id" text,
	"cover_art_sizes_original_id" text,
	"primary_color" text,
	"secondary_color" text,
	"audio_source_key" text,
	"audio_source_format" text,
	"hls_master_key" text,
	"loudness_lufs" double precision,
	"status" text DEFAULT 'processing' NOT NULL,
	"matched_track_id" text,
	"resolved_artist_id" text,
	"last_played_at" timestamp with time zone,
	"play_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"deletion_notice_sent_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"provenance_score" double precision,
	"provenance_verdict" text,
	"raw_tags_format" text,
	"raw_tags_json" text,
	"raw_tags_truncated" boolean,
	"raw_tags_original_byte_length" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_uploads_owner_oxy_user_id_sha256_key" UNIQUE("owner_oxy_user_id","sha256"),
	CONSTRAINT "user_uploads_status_check" CHECK ("user_uploads"."status" in ('processing', 'ready', 'failed')),
	CONSTRAINT "user_uploads_audio_source_format_check" CHECK ("user_uploads"."audio_source_format" is null or "user_uploads"."audio_source_format" in ('mp3', 'flac', 'ogg', 'm4a', 'wav')),
	CONSTRAINT "user_uploads_provenance_verdict_check" CHECK ("user_uploads"."provenance_verdict" is null or "user_uploads"."provenance_verdict" in ('clean', 'suspect', 'commercial')),
	CONSTRAINT "user_uploads_play_count_check" CHECK ("user_uploads"."play_count" >= 0),
	CONSTRAINT "user_uploads_size_bytes_check" CHECK ("user_uploads"."size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "artist_claims" ADD CONSTRAINT "artist_claims_artist_id_catalog_entities_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."catalog_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_attestation_provenance_markers" ADD CONSTRAINT "contribution_attestation_provenance_markers_attestation_id_fk" FOREIGN KEY ("contribution_attestation_id") REFERENCES "public"."contribution_attestations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_attestations" ADD CONSTRAINT "contribution_attestations_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_strikes" ADD CONSTRAINT "contributor_strikes_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_strikes" ADD CONSTRAINT "contributor_strikes_contributor_standing_id_fk" FOREIGN KEY ("contributor_standing_id") REFERENCES "public"."contributor_standings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copyright_reports" ADD CONSTRAINT "copyright_reports_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copyright_reports" ADD CONSTRAINT "copyright_reports_artist_id_catalog_entities_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."catalog_entities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_upload_hls_renditions" ADD CONSTRAINT "user_upload_hls_renditions_user_upload_id_user_uploads_id_fk" FOREIGN KEY ("user_upload_id") REFERENCES "public"."user_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_upload_provenance_markers" ADD CONSTRAINT "user_upload_provenance_markers_user_upload_id_fk" FOREIGN KEY ("user_upload_id") REFERENCES "public"."user_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_uploads" ADD CONSTRAINT "user_uploads_cover_art_id_image_assets_id_fk" FOREIGN KEY ("cover_art_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_uploads" ADD CONSTRAINT "user_uploads_cover_art_sizes_small_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_small_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_uploads" ADD CONSTRAINT "user_uploads_cover_art_sizes_medium_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_medium_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_uploads" ADD CONSTRAINT "user_uploads_cover_art_sizes_large_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_large_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_uploads" ADD CONSTRAINT "user_uploads_cover_art_sizes_xlarge_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_xlarge_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_uploads" ADD CONSTRAINT "user_uploads_cover_art_sizes_xxlarge_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_xxlarge_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_uploads" ADD CONSTRAINT "user_uploads_cover_art_sizes_original_id_image_assets_id_fk" FOREIGN KEY ("cover_art_sizes_original_id") REFERENCES "public"."image_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_uploads" ADD CONSTRAINT "user_uploads_matched_track_id_tracks_id_fk" FOREIGN KEY ("matched_track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_uploads" ADD CONSTRAINT "user_uploads_resolved_artist_id_catalog_entities_id_fk" FOREIGN KEY ("resolved_artist_id") REFERENCES "public"."catalog_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artist_claims_artist_id_oxy_user_id_pending_key" ON "artist_claims" USING btree ("artist_id","oxy_user_id") WHERE "artist_claims"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "artist_claims_oxy_user_id_created_at_idx" ON "artist_claims" USING btree ("oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "artist_claims_status_created_at_idx" ON "artist_claims" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "contribution_attestations_uploader_oxy_user_id_idx" ON "contribution_attestations" USING btree ("uploader_oxy_user_id");--> statement-breakpoint
CREATE INDEX "contributor_strikes_contributor_standing_id_idx" ON "contributor_strikes" USING btree ("contributor_standing_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "copyright_reports_track_id_status_idx" ON "copyright_reports" USING btree ("track_id","status");--> statement-breakpoint
CREATE INDEX "copyright_reports_status_created_at_idx" ON "copyright_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "user_uploads_owner_oxy_user_id_created_at_idx" ON "user_uploads" USING btree ("owner_oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_uploads_owner_oxy_user_id_status_idx" ON "user_uploads" USING btree ("owner_oxy_user_id","status");--> statement-breakpoint
CREATE INDEX "user_uploads_owner_oxy_user_id_album_key_idx" ON "user_uploads" USING btree ("owner_oxy_user_id","album_key","disc_number","track_number");--> statement-breakpoint
CREATE INDEX "user_uploads_sha256_idx" ON "user_uploads" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "user_uploads_fingerprint_duration_sec_idx" ON "user_uploads" USING btree ("fingerprint_duration_sec");--> statement-breakpoint
CREATE INDEX "user_uploads_expires_at_idx" ON "user_uploads" USING btree ("expires_at") WHERE "user_uploads"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "user_uploads_deleted_at_idx" ON "user_uploads" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "user_uploads_matched_track_id_idx" ON "user_uploads" USING btree ("matched_track_id");