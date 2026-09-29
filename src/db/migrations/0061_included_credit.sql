-- Monthly included server credit (plan-approved 2026-09-29). Additive only.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "included_credit_cents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "included_credit_period_key" varchar(10);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "included_credit_period_end" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "stripe_current_period_start" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "billing_interval" varchar(8);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "included_credit_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_key" varchar(10) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"plan" varchar(16) NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "included_credit_grants" ADD CONSTRAINT "included_credit_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- One period grant per organization and period, whatever triggers it (worker, invoice.paid,
-- checkout): a second insert is rejected, so credit can never be granted twice.
CREATE UNIQUE INDEX IF NOT EXISTS "included_credit_grants_period_uq" ON "included_credit_grants" ("organization_id","period_key") WHERE "kind" = 'period';
--> statement-breakpoint
-- One upgrade top-up per organization, period and target plan.
CREATE UNIQUE INDEX IF NOT EXISTS "included_credit_grants_upgrade_uq" ON "included_credit_grants" ("organization_id","period_key","plan") WHERE "kind" = 'upgrade';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "included_credit_grants_org_period_idx" ON "included_credit_grants" ("organization_id","period_key");
