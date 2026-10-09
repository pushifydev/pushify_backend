-- External secret manager connections (Infisical). Only the machine identity's client secret is
-- stored, encrypted; resolved secret values are never written to the database. Additive.
CREATE TABLE IF NOT EXISTS "secret_provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"provider" varchar(30) NOT NULL,
	"site_url" varchar(500) NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"client_secret_encrypted" text NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"environment" varchar(64) NOT NULL,
	"secret_path" varchar(500) DEFAULT '/' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "secret_provider_connections" ADD CONSTRAINT "secret_provider_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "secret_provider_connections" ADD CONSTRAINT "secret_provider_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_provider_connections_org_idx" ON "secret_provider_connections" USING btree ("organization_id");
