CREATE TYPE "public"."billing_status" AS ENUM('active', 'past_due', 'suspended');--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "billing_status" "billing_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "billing_payment_failed_notified_at" timestamp with time zone;