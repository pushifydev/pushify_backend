CREATE TABLE IF NOT EXISTS "marketplace_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"template_id" varchar(100) NOT NULL,
	"template_version" varchar(50) NOT NULL,
	"app_version" varchar(50) NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "google_id" varchar(255);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "install_command" varchar(500);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "output_directory" varchar(255);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "marketplace_deployments" ADD CONSTRAINT "marketplace_deployments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_google_id_unique" UNIQUE("google_id");