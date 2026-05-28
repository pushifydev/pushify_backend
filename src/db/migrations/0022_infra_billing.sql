CREATE TYPE "public"."infra_wallet_transaction_type" AS ENUM('credit_topup', 'server_hourly_charge', 'server_refund', 'adjustment');--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "infra_wallet_balance_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "provider_server_type" varchar(64);--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "provider_cost_monthly_cents" integer;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "provider_cost_hourly_cents" integer;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "customer_price_monthly_cents" integer;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "customer_price_hourly_cents" integer;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "infra_last_charged_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "infra_wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid,
	"type" "infra_wallet_transaction_type" NOT NULL,
	"amount_cents" integer NOT NULL,
	"balance_after_cents" integer NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stripe_checkout_session_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "infra_wallet_transactions" ADD CONSTRAINT "infra_wallet_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_wallet_transactions" ADD CONSTRAINT "infra_wallet_transactions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "infra_wallet_transactions_org_created_idx" ON "infra_wallet_transactions" ("organization_id", "created_at" DESC);
