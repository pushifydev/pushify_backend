CREATE TYPE "public"."server_provider" AS ENUM('hetzner', 'digitalocean', 'aws', 'gcp', 'self_hosted');--> statement-breakpoint
CREATE TYPE "public"."server_size" AS ENUM('xs', 'sm', 'md', 'lg', 'xl', 'custom');--> statement-breakpoint
CREATE TYPE "public"."server_status" AS ENUM('provisioning', 'running', 'stopped', 'rebooting', 'error', 'deleting');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "server_firewall_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"direction" varchar(10) NOT NULL,
	"protocol" varchar(10) NOT NULL,
	"port" varchar(20),
	"source_ips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "server_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"provider_id" varchar(255),
	"size_gb" integer,
	"status" varchar(50) DEFAULT 'creating' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"provider" "server_provider" NOT NULL,
	"provider_id" varchar(255),
	"provider_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"size" "server_size" DEFAULT 'sm' NOT NULL,
	"region" varchar(100) NOT NULL,
	"image" varchar(255),
	"vcpus" integer DEFAULT 1 NOT NULL,
	"memory_mb" integer DEFAULT 1024 NOT NULL,
	"disk_gb" integer DEFAULT 20 NOT NULL,
	"ipv4" varchar(45),
	"ipv6" varchar(45),
	"private_ip" varchar(45),
	"status" "server_status" DEFAULT 'provisioning' NOT NULL,
	"status_message" text,
	"ssh_key_id" varchar(255),
	"root_password" text,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_managed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "server_firewall_rules" ADD CONSTRAINT "server_firewall_rules_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "server_snapshots" ADD CONSTRAINT "server_snapshots_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "servers" ADD CONSTRAINT "servers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
