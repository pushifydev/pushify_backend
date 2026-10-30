-- Maintenance mode: while enabled, nginx answers every production domain of the project with a
-- 503 maintenance page (Retry-After set) instead of proxying to the app; the containers keep
-- running. Additive; existing projects start with it off.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "maintenance_mode" jsonb DEFAULT '{"enabled":false}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'project.maintenance_enabled';
--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'project.maintenance_disabled';
