-- When a managed server was powered off, and which warning it has had, so one left off for
-- non-payment is deleted after 30 days (warnings on day 14 and 27). Additive.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "stopped_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "stop_warning_step" smallint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "servers_stopped_at_idx" ON "servers" ("stopped_at") WHERE "stopped_at" IS NOT NULL;
