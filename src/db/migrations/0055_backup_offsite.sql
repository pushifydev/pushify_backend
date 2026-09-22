ALTER TABLE "database_backups" ADD COLUMN IF NOT EXISTS "offsite_path" text;
--> statement-breakpoint
ALTER TABLE "database_backups" ADD COLUMN IF NOT EXISTS "offsite_status" varchar(20);
