-- marketplace_deployments.configuration held every env var of a marketplace app in plain text
-- (generated passwords, Supabase JWT_SECRET / SERVICE_ROLE_KEY). The same values are stored
-- encrypted in environment_variables, so keep only the key names here (a jsonb array of strings).
UPDATE "marketplace_deployments"
   SET "configuration" = COALESCE(
         (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys("configuration") AS k),
         '[]'::jsonb)
 WHERE jsonb_typeof("configuration") = 'object';
--> statement-breakpoint
ALTER TABLE "marketplace_deployments" ALTER COLUMN "configuration" SET DEFAULT '[]'::jsonb;
