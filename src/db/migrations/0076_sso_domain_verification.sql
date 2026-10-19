-- SSO email domains need proof of ownership (a TXT record at _pushify-verify.<domain>) before
-- they route sign-ins, are accepted from the provider or are enforced. Every domain already on a
-- connection starts pending with a fresh token; the owner verifies it from the dashboard
-- (POST /api/v1/sso/domains/verify). For the transition an operator can mark a domain whose
-- ownership was checked by hand as verified:
--   UPDATE sso_connections
--      SET domain_verifications = jsonb_set(domain_verifications, '{acme.com,verifiedAt}', to_jsonb(now()::text))
--    WHERE organization_id = '<org id>';
ALTER TABLE "sso_connections" ADD COLUMN IF NOT EXISTS "domain_verifications" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "sso_connections"
   SET "domain_verifications" = COALESCE(
     (SELECT jsonb_object_agg(d, jsonb_build_object('token', replace(gen_random_uuid()::text, '-', ''), 'verifiedAt', NULL))
        FROM jsonb_array_elements_text("email_domains") AS d),
     '{}'::jsonb)
 WHERE "domain_verifications" = '{}'::jsonb;
