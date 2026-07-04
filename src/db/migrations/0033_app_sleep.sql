ALTER TABLE "projects" ADD COLUMN "sleep_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "sleep_after_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "sleep_state" varchar(10) DEFAULT 'awake' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "last_wake_at" timestamp with time zone;