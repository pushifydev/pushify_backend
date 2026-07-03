CREATE TABLE IF NOT EXISTS "project_volumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(32) NOT NULL,
	"container_path" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_volumes" ADD CONSTRAINT "project_volumes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_volumes_name_idx" ON "project_volumes" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_volumes_path_idx" ON "project_volumes" USING btree ("project_id","container_path");