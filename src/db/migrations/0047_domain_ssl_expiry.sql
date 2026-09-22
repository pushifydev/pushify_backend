ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "ssl_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "ssl_expiry_notified_at" timestamp with time zone;
