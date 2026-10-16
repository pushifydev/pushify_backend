-- Whose problem a down site is (user_caused/build_failed | platform), so a project whose own
-- build broke leaves the operations list of open platform issues. Nullable, additive.
ALTER TABLE "project_health_state" ADD COLUMN IF NOT EXISTS "cause" varchar(32);
