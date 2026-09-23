ALTER TABLE "databases" ADD COLUMN IF NOT EXISTS "backup_interval_hours" integer DEFAULT 24 NOT NULL;
