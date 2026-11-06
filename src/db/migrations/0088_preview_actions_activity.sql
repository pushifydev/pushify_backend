-- Redeploying and closing a PR preview from the dashboard / API
-- (POST /projects/:projectId/previews/:previewId/redeploy | close) go to the audit log.
-- Additive enum values only.
ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'preview.redeployed';
--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'preview.closed';
