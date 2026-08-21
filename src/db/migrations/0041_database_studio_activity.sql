ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'database.data_modified';--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'database.query_executed';
