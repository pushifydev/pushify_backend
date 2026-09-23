CREATE TABLE IF NOT EXISTS "project_resource_state" (
	"project_id" uuid NOT NULL,
	"resource" varchar(16) NOT NULL,
	"since" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"last_percent" real,
	"last_container" varchar(255),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_resource_state_pk" PRIMARY KEY("project_id","resource")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_resource_state" ADD CONSTRAINT "project_resource_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "disk_used_percent" integer;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "disk_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "disk_notified_at" timestamp with time zone;
