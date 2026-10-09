-- Traffic analytics: 2xx/3xx counts and a per-hour request-time histogram (for p95). Additive;
-- rows stored before this have zeros / an empty histogram.
ALTER TABLE "project_traffic_hourly" ADD COLUMN IF NOT EXISTS "status_2xx" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_traffic_hourly" ADD COLUMN IF NOT EXISTS "status_3xx" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_traffic_hourly" ADD COLUMN IF NOT EXISTS "latency_buckets" bigint[] DEFAULT '{}'::bigint[] NOT NULL;
