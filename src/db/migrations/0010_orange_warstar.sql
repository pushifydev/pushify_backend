ALTER TABLE "projects" ADD COLUMN "server_id" uuid;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "ssh_private_key" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "ssh_public_key" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "projects" ADD CONSTRAINT "projects_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
