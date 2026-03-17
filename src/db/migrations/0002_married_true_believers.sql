CREATE TYPE "public"."git_provider" AS ENUM('github', 'gitlab', 'bitbucket');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "git_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "git_provider" NOT NULL,
	"provider_account_id" varchar(255) NOT NULL,
	"provider_username" varchar(255),
	"access_token" text NOT NULL,
	"refresh_token" text,
	"token_expires_at" timestamp with time zone,
	"scopes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "webhook_secret" varchar(64);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "git_integrations" ADD CONSTRAINT "git_integrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
