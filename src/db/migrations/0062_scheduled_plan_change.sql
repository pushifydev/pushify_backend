-- Plan changes that take effect at period end (downgrades), driven by a Stripe subscription
-- schedule. Additive only.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "pending_plan" varchar(16);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "pending_billing_interval" varchar(8);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "pending_change_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "stripe_schedule_id" varchar(255);
