ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "autoscale_observe_only" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_scale_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"from_count" integer NOT NULL,
	"to_count" integer NOT NULL,
	"average_cpu" real,
	"reason" text NOT NULL,
	"applied" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_scale_events" ADD CONSTRAINT "project_scale_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_scale_events_project_created_idx" ON "project_scale_events" USING btree ("project_id","created_at");
