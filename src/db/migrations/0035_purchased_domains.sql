CREATE TYPE "public"."purchased_domain_status" AS ENUM('active', 'expired');--> statement-breakpoint
ALTER TYPE "public"."infra_wallet_transaction_type" ADD VALUE 'domain_purchase';--> statement-breakpoint
ALTER TYPE "public"."infra_wallet_transaction_type" ADD VALUE 'domain_renewal';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchased_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"domain_name" varchar(255) NOT NULL,
	"registrar" varchar(32) DEFAULT 'namecom' NOT NULL,
	"status" "purchased_domain_status" DEFAULT 'active' NOT NULL,
	"years" integer DEFAULT 1 NOT NULL,
	"purchase_price_cents" integer NOT NULL,
	"wholesale_price_cents" integer NOT NULL,
	"renewal_wholesale_cents" integer,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_renewal_error" text,
	"renewal_reminder_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchased_domains_domain_name_unique" UNIQUE("domain_name")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchased_domains" ADD CONSTRAINT "purchased_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchased_domains" ADD CONSTRAINT "purchased_domains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
