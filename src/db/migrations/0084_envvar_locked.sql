-- Locked (admin-only) environment variables: only owners and admins can read or change the value of
-- a locked variable; members and viewers get it withheld (`****`, `masked: true`). Deploys inject it
-- as usual. Additive; existing variables start unlocked.
ALTER TABLE "environment_variables" ADD COLUMN IF NOT EXISTS "locked" boolean DEFAULT false NOT NULL;
