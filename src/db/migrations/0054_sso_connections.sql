CREATE TABLE IF NOT EXISTS "sso_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"issuer" varchar(500) NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"client_secret_encrypted" text NOT NULL,
	"email_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enforced" boolean DEFAULT false NOT NULL,
	"default_role" varchar(20) DEFAULT 'member' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sso_connections_organization_idx" ON "sso_connections" USING btree ("organization_id");
