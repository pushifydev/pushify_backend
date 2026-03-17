ALTER TABLE "domains" ADD COLUMN "nginx_settings" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;