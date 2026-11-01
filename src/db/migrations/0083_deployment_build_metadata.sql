-- How a deploy's build was decided, written by the API and the deploy worker: a forced redeploy is
-- marked when it is created; a compose stack records the hash of its build inputs and the image IDs
-- it ran, so a redeploy that changed only runtime variables or replicas can skip
-- `docker compose build` (lib/compose-build-cache.ts). Nullable; additive.
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "build_metadata" jsonb;
