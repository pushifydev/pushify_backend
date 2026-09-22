ALTER TABLE "container_logs" ADD COLUMN IF NOT EXISTS "container_name" varchar(255);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "container_logs_project_created_idx" ON "container_logs" USING btree ("project_id","created_at");
