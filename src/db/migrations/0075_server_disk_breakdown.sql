-- Managed servers: what holds the disk (images / build cache / logs / volumes), written by the
-- scheduled Docker cleanup. Nullable; existing rows keep NULL until the next cleanup. Additive.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "disk_breakdown" jsonb;
