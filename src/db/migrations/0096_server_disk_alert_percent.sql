-- A server's own disk alert threshold (PATCH /servers/:serverId `diskAlertPercent`, 50-99). NULL
-- (every existing row) keeps the install-wide SERVER_DISK_WARN_PERCENT, 85 by default.
-- Additive nullable column only.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "disk_alert_percent" smallint;
