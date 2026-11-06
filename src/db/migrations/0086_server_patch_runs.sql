-- Applying OS security updates on a server (POST /servers/:serverId/patches/apply): the request
-- and the outcome of each run go to the audit log, and the outcomes also show on the server
-- timeline (read back by metadata->>'serverId'). Additive enum values only.
ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'server.patches_requested';
--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'server.patches_applied';
--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'server.patches_failed';
