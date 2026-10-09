-- Acceptable Use enforcement: a review queue for flagged projects, an audit trail of admin
-- decisions, and the suspension fields on projects. Additive; no existing row changes.
CREATE TABLE IF NOT EXISTS "abuse_flags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
  "organization_id" uuid REFERENCES "organizations"("id") ON DELETE CASCADE,
  "deployment_id" uuid REFERENCES "deployments"("id") ON DELETE SET NULL,
  "source" varchar(16) NOT NULL,
  "status" varchar(16) DEFAULT 'open' NOT NULL,
  "score" integer DEFAULT 0 NOT NULL,
  "reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reported_url" varchar(500),
  "reporter_email" varchar(255),
  "report_text" text,
  "reviewed_at" timestamp with time zone,
  "reviewed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abuse_flags_status_idx" ON "abuse_flags" ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abuse_flags_project_idx" ON "abuse_flags" ("project_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "abuse_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "flag_id" uuid REFERENCES "abuse_flags"("id") ON DELETE SET NULL,
  "admin_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "action" varchar(16) NOT NULL,
  "reason" text,
  "clause" varchar(64),
  "ends_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "abuse_actions_project_idx" ON "abuse_actions" ("project_id", "created_at");
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "suspension_reason" text;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "suspension_clause" varchar(64);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "suspension_ends_at" timestamp with time zone;
--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'project.suspended';
--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'project.unsuspended';
