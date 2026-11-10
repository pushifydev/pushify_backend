-- Compose stacks: when the deploy pulls the stack's images. 'always' (what every compose deploy
-- already did) pulls them on every deploy, even when the build is skipped; 'missing' pulls only
-- images not on the server yet. pushify.yaml `pullPolicy` wins over it.
-- Additive column with a default only.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "compose_pull_policy" varchar(10) DEFAULT 'always' NOT NULL;
