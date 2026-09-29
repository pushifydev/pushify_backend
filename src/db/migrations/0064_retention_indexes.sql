-- Retention sweeps delete or trim rows by age; without these, each daily run scans the whole table.
-- On a large production table, create them CONCURRENTLY by hand before deploying (this file is
-- then a no-op thanks to IF NOT EXISTS).
CREATE INDEX IF NOT EXISTS "activity_logs_created_idx" ON "activity_logs" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployments_created_idx" ON "deployments" ("created_at");
