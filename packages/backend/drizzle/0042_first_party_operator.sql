-- oxy:deploy-phase=pre
--
-- Syra stores a person's audio in their Oxy Files on its own declared authority
-- (oxy ADR 0066: Syra's registry entry declares `oxy:files` write), naming the
-- owner and, when a person operates the owning account (an organization), that
-- person. This column records that person for the background copy; null when
-- the owner asked. It replaces `oxy_task_id`, which `0043` drops once the
-- previous image, which still mints and stores tasks, has drained.
ALTER TABLE "user_uploads" ADD COLUMN "operator_oxy_user_id" text;--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "operator_oxy_user_id" text;
