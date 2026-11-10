-- When a repository compose stack deploy pulls its images (lib/compose-pull.ts): 'always' (every
-- deploy, what compose deploys already did — the default, so existing projects are unchanged) or
-- 'missing' (only images not on the server yet). pushify.yaml `pullPolicy` wins over it.
-- Additive column with a default only.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "compose_pull_policy" varchar(10) DEFAULT 'always' NOT NULL;
