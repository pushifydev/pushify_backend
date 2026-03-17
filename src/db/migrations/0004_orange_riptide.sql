CREATE TABLE IF NOT EXISTS "container_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"deployment_id" uuid,
	"container_name" varchar(255) NOT NULL,
	"cpu_percent" real NOT NULL,
	"memory_usage_bytes" bigint NOT NULL,
	"memory_limit_bytes" bigint NOT NULL,
	"memory_percent" real NOT NULL,
	"network_rx_bytes" bigint NOT NULL,
	"network_tx_bytes" bigint NOT NULL,
	"block_read_bytes" bigint NOT NULL,
	"block_write_bytes" bigint NOT NULL,
	"container_status" varchar(50) NOT NULL,
	"pids" bigint,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "container_metrics" ADD CONSTRAINT "container_metrics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "container_metrics" ADD CONSTRAINT "container_metrics_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
