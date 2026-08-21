DO $$ BEGIN
 CREATE TYPE "public"."studio_access" AS ENUM('none', 'read', 'write');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN IF NOT EXISTS "studio_access" "studio_access" DEFAULT 'none' NOT NULL;
