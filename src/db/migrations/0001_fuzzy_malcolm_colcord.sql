CREATE TYPE "public"."deployment_status" AS ENUM('pending', 'building', 'deploying', 'running', 'failed', 'stopped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."deployment_trigger" AS ENUM('manual', 'git_push', 'rollback', 'redeploy');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" "deployment_status" DEFAULT 'pending' NOT NULL,
	"trigger" "deployment_trigger" DEFAULT 'manual' NOT NULL,
	"commit_hash" varchar(40),
	"commit_message" text,
	"branch" varchar(100),
	"build_logs" text,
	"deploy_logs" text,
	"error_message" text,
	"build_started_at" timestamp with time zone,
	"build_finished_at" timestamp with time zone,
	"deploy_started_at" timestamp with time zone,
	"deploy_finished_at" timestamp with time zone,
	"triggered_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployments" ADD CONSTRAINT "deployments_triggered_by_id_users_id_fk" FOREIGN KEY ("triggered_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
