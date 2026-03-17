CREATE TYPE "public"."database_status" AS ENUM('provisioning', 'running', 'stopped', 'error', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."database_type" AS ENUM('postgresql', 'mysql', 'redis', 'mongodb');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "container_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"log_content" text NOT NULL,
	"log_type" varchar(20) DEFAULT 'stdout' NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"start_timestamp" timestamp with time zone,
	"end_timestamp" timestamp with time zone,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "database_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"database_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(50) DEFAULT 'automatic' NOT NULL,
	"status" varchar(50) DEFAULT 'creating' NOT NULL,
	"size_mb" integer,
	"file_path" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "database_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"database_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"env_var_name" varchar(255) DEFAULT 'DATABASE_URL' NOT NULL,
	"permissions" varchar(50) DEFAULT 'readwrite' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "databases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid,
	"name" varchar(255) NOT NULL,
	"description" text,
	"type" "database_type" NOT NULL,
	"version" varchar(50) NOT NULL,
	"host" varchar(255),
	"port" integer NOT NULL,
	"database_name" varchar(255) NOT NULL,
	"username" varchar(255) NOT NULL,
	"password" text NOT NULL,
	"connection_string" text,
	"status" "database_status" DEFAULT 'provisioning' NOT NULL,
	"status_message" text,
	"max_connections" integer DEFAULT 100,
	"storage_mb" integer DEFAULT 1024,
	"used_storage_mb" integer DEFAULT 0,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"backup_enabled" boolean DEFAULT true NOT NULL,
	"backup_retention_days" integer DEFAULT 7,
	"last_backup_at" timestamp with time zone,
	"container_name" varchar(255),
	"container_port" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "docker_image_id" varchar(100);--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "container_port" integer;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "rollback_from_deployment_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "container_logs" ADD CONSTRAINT "container_logs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "container_logs" ADD CONSTRAINT "container_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "database_backups" ADD CONSTRAINT "database_backups_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "databases" ADD CONSTRAINT "databases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "databases" ADD CONSTRAINT "databases_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "container_logs_deployment_idx" ON "container_logs" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "container_logs_project_idx" ON "container_logs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "container_logs_time_idx" ON "container_logs" USING btree ("deployment_id","chunk_index");