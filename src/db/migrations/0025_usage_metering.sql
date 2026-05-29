CREATE TABLE IF NOT EXISTS "organization_monthly_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"bandwidth_bytes" bigint DEFAULT 0 NOT NULL,
	"storage_bytes_peak" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_monthly_usage" ADD CONSTRAINT "organization_monthly_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_monthly_usage_org_period_idx" ON "organization_monthly_usage" USING btree ("organization_id","period_start");
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "grandfathered_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "plan_limits_override" jsonb;
--> statement-breakpoint
UPDATE "organizations"
SET "grandfathered_until" = NOW() + INTERVAL '90 days'
WHERE "plan" IN ('hobby', 'pro', 'business')
  AND "grandfathered_until" IS NULL;
