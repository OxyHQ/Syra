-- oxy:deploy-phase=post
--
-- Syra no longer keeps an Oxy task per upload or episode (oxy ADR 0066): it
-- names the account it acts for (`0042`'s `operator_oxy_user_id` beside the
-- owner), and Oxy checks its declared authority live. So the task handles,
-- their revocation outbox and the triggers that fed it go.
--
-- `post`, because the image this rollout replaces still writes `oxy_task_id`
-- and fires the triggers until it drains. Nothing revokes the outstanding
-- tasks from here: Oxy retires the task store itself (ADR 0066, delivery 3),
-- and every one expired within a day of being minted.
DROP TRIGGER IF EXISTS "user_uploads_revoke_file_task" ON "user_uploads";--> statement-breakpoint
DROP TRIGGER IF EXISTS "episodes_revoke_file_task" ON "episodes";--> statement-breakpoint
DROP FUNCTION IF EXISTS syra_queue_file_task_revocation();--> statement-breakpoint
DROP TABLE "oxy_file_task_revocations" CASCADE;--> statement-breakpoint
ALTER TABLE "user_uploads" DROP COLUMN "oxy_task_id";--> statement-breakpoint
ALTER TABLE "episodes" DROP COLUMN "oxy_task_id";
