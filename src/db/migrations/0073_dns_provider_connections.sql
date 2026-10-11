-- Organization DNS provider credentials (Cloudflare). Only the API token is stored, encrypted.
-- Additive.
CREATE TABLE IF NOT EXISTS "dns_provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" varchar(30) NOT NULL,
	"api_token_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dns_provider_connections" ADD CONSTRAINT "dns_provider_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dns_provider_connections_org_provider_idx" ON "dns_provider_connections" USING btree ("organization_id","provider");
