ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "auto_snapshot_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "last_auto_snapshot_at" timestamp with time zone;
