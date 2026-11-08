-- Scheduled automatic security updates per server (PUT /servers/:serverId/auto-patch), off by
-- default. The schedule itself is a BullMQ job scheduler; these columns are the setting and the
-- outcome of the last scheduled run (shown in the health report). A scheduled run put off for the
-- whole maintenance window by a deploy is audited as server.patches_skipped.
-- Additive columns with defaults and an additive enum value only.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "auto_patch" varchar(10) DEFAULT 'off' NOT NULL;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "auto_patch_hour" smallint DEFAULT 3 NOT NULL;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "auto_patch_weekday" smallint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "last_auto_patch" jsonb;
--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'server.patches_skipped';
