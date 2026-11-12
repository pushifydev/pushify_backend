-- Scheduled security update runs email the organization only when a run fails or leaves a reboot
-- pending, once per condition. This column keeps what was already announced (failure code, pending
-- reboot) so the next run does not send it again. NULL (every existing row) means nothing was.
-- Additive nullable column only.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "auto_patch_notified" jsonb;
