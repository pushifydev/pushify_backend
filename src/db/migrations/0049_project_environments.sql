ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "staging_branch" varchar(255);
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "environment" varchar(20) DEFAULT 'production' NOT NULL;
--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "environment" varchar(20) DEFAULT 'production' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployments_project_environment_idx" ON "deployments" USING btree ("project_id","environment","created_at");
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "promoted_from_deployment_id" uuid;
