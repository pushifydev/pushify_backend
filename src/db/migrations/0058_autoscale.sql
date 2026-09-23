ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "autoscale_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "autoscale_min" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "autoscale_max" integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "autoscaled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "run_spec_encrypted" text;
