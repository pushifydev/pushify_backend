-- Per-app hourly traffic totals (requests, 4xx, 5xx, bytes) from each app's Nginx access log.
-- Additive; rows are pruned by the retention sweep.
CREATE TABLE IF NOT EXISTS "project_traffic_hourly" (
	"project_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"status_4xx" bigint DEFAULT 0 NOT NULL,
	"status_5xx" bigint DEFAULT 0 NOT NULL,
	"bytes_sent" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "project_traffic_hourly_pk" PRIMARY KEY("project_id","hour")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_traffic_hourly" ADD CONSTRAINT "project_traffic_hourly_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_traffic_hourly_hour_idx" ON "project_traffic_hourly" USING btree ("hour");
