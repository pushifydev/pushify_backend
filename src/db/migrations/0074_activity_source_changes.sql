-- Audit log: where an action came from (ui / api / webhook / system) and a field-level
-- before/after diff. Both nullable; existing entries keep NULL. Additive.
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "source" varchar(20);
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "changes" jsonb;
