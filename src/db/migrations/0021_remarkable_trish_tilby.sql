ALTER TABLE "organizations" ADD COLUMN "stripe_customer_id" varchar(255);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "stripe_subscription_id" varchar(255);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "stripe_current_period_end" timestamp with time zone;