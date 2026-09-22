ALTER TABLE "databases" ADD COLUMN IF NOT EXISTS "readonly_username" varchar(100);
--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN IF NOT EXISTS "readonly_password" text;
