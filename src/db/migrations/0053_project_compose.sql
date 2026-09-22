ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "compose_path" varchar(255);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "compose_service" varchar(100);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "compose_port" integer;
