-- oxy:deploy-phase=pre
-- New, initially empty tables; their foreign keys are installed with creation.
CREATE TABLE "playlist_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"playlist_id" text NOT NULL,
	"actor_oxy_user_id" text NOT NULL,
	"action" text NOT NULL,
	"target_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "playlist_activity_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "playlist_activity_action_check" CHECK ("playlist_activity"."action" in ('tracks_added', 'tracks_removed', 'tracks_reordered', 'member_joined', 'member_removed', 'role_changed', 'invites_revoked'))
);
--> statement-breakpoint
CREATE TABLE "playlist_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"playlist_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"role" text NOT NULL,
	"issued_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "playlist_invites_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "playlist_invites_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "playlist_invites_role_check" CHECK ("playlist_invites"."role" in ('editor', 'viewer'))
);
--> statement-breakpoint
CREATE INDEX "playlist_activity_playlist_created_idx" ON "playlist_activity" USING btree ("playlist_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "playlist_invites_playlist_id_idx" ON "playlist_invites" USING btree ("playlist_id");
