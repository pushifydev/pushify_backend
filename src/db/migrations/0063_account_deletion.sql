-- Organization and account deletion: a 30-day grace period, then a permanent purge.
-- Additive, except organization_members.invited_by, which relaxes from NO ACTION to SET NULL
-- so that deleting a user who invited someone no longer fails.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "deletion_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "deletion_scheduled_for" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "deletion_requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organizations_deletion_due_idx" ON "organizations" ("deletion_scheduled_for") WHERE "deletion_scheduled_for" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deletion_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deletion_scheduled_for" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_deletion_due_idx" ON "users" ("deletion_scheduled_for") WHERE "deletion_scheduled_for" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_members" DROP CONSTRAINT IF EXISTS "organization_members_invited_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
-- What is kept after a purge: invoice and payment facts only.
CREATE TABLE IF NOT EXISTS "deleted_organizations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "billing_email" varchar(255),
  "stripe_customer_id" varchar(255),
  "wallet_ledger" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "deletion_requested_at" timestamp with time zone NOT NULL,
  "purged_at" timestamp with time zone DEFAULT now() NOT NULL,
  "retain_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Purge progress per organization; no foreign key, the organization row is deleted last.
CREATE TABLE IF NOT EXISTS "deletion_purge_steps" (
  "organization_id" uuid NOT NULL,
  "step" varchar(64) NOT NULL,
  "status" varchar(16) NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "deletion_purge_steps_pk" PRIMARY KEY ("organization_id", "step")
);
