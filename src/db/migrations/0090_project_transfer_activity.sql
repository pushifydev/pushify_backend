-- Moving a project to another server (POST /projects/:projectId/transfer) goes to the audit log.
-- The move itself is recorded on the deploy that performs it (deployments.build_metadata.transfer).
-- Additive enum values only.
ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'project.transfer_started';
--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'project.transferred';
--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'project.transfer_failed';
