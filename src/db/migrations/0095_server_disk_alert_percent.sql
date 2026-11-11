-- Per-server disk alert threshold (PATCH /servers/:serverId `diskAlertPercent`). Null keeps the
-- install default SERVER_DISK_WARN_PERCENT (85), so existing servers are unchanged.
-- Additive nullable column only.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "disk_alert_percent" smallint;
