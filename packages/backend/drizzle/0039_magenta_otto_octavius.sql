-- oxy:deploy-phase=pre
-- Original audio task handles and durable revocation on deletion/replacement.
CREATE TABLE "oxy_file_task_revocations" (
	"task_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_uploads" ADD COLUMN "oxy_task_id" text;--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "oxy_task_id" text;
--> statement-breakpoint
CREATE FUNCTION syra_queue_file_task_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.oxy_task_id IS NOT NULL AND (TG_OP = 'DELETE' OR OLD.oxy_task_id IS DISTINCT FROM NEW.oxy_task_id) THEN
    INSERT INTO oxy_file_task_revocations(task_id) VALUES (OLD.oxy_task_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_uploads_revoke_file_task AFTER DELETE OR UPDATE OF oxy_task_id ON user_uploads
FOR EACH ROW EXECUTE FUNCTION syra_queue_file_task_revocation();
--> statement-breakpoint
CREATE TRIGGER episodes_revoke_file_task AFTER DELETE OR UPDATE OF oxy_task_id ON episodes
FOR EACH ROW EXECUTE FUNCTION syra_queue_file_task_revocation();
