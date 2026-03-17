CREATE TYPE "public"."activity_action" AS ENUM('project.created', 'project.updated', 'project.deleted', 'project.paused', 'project.resumed', 'deployment.created', 'deployment.cancelled', 'deployment.redeployed', 'deployment.rolledback', 'deployment.succeeded', 'deployment.failed', 'envvar.created', 'envvar.updated', 'envvar.deleted', 'domain.added', 'domain.removed', 'domain.verified', 'domain.set_primary', 'apikey.created', 'apikey.revoked', 'member.invited', 'member.removed', 'member.role_changed', 'settings.updated', 'webhook.regenerated', 'notification.channel_created', 'notification.channel_updated', 'notification.channel_deleted', 'healthcheck.enabled', 'healthcheck.disabled', 'healthcheck.updated');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"project_id" uuid,
	"action" "activity_action" NOT NULL,
	"description" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" varchar(45),
	"user_agent" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
