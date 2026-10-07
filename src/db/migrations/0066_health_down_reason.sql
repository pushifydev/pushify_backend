-- Why a project is down (server_unreachable | app_error | deploy_failed) and how many reminders
-- (24h, 72h) the current outage has had. Additive.
ALTER TABLE "project_health_state" ADD COLUMN IF NOT EXISTS "down_reason" varchar(32);
--> statement-breakpoint
ALTER TABLE "project_health_state" ADD COLUMN IF NOT EXISTS "reminder_step" smallint DEFAULT 0 NOT NULL;
