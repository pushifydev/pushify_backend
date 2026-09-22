CREATE TABLE IF NOT EXISTS "project_health_state" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"url" text,
	"status" varchar(10) DEFAULT 'unknown' NOT NULL,
	"status_code" integer,
	"response_time_ms" integer,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"down_since" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_health_state" ADD CONSTRAINT "project_health_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
