-- Why a failed deployment failed, written by the deploy worker where it stops the deploy
-- (lib/deploy-failure-classify.ts). 'policy_blocked' = stopped under the Acceptable Use Policy:
-- not a failure, kept out of the failure rate. Nullable; additive.
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "failure_category" varchar(32);
--> statement-breakpoint
-- Backfill the deploys stopped under the Acceptable Use Policy before the column existed. The
-- worker stored "[Blame] Label: " followed by this fixed sentence; nothing else writes it.
UPDATE "deployments" SET "failure_category" = 'policy_blocked'
 WHERE "status" = 'failed' AND "failure_category" IS NULL
   AND "error_message" ~ '^\[(Pushify|Server|Project)\] [^:]{1,80}: This deploy was stopped and the project suspended under the Pushify Acceptable Use Policy';
