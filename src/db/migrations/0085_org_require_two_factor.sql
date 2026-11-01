-- Organization-wide two-factor policy: while on, a member signed in with a session (JWT) who has
-- no TOTP set up gets 403 ORG_2FA_REQUIRED on organization-scoped routes, except the few needed to
-- fix it (profile, 2FA setup, logout, switching organization). API keys are not affected yet.
-- Only the owner can change it. Additive; existing organizations start with it off.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "require_two_factor" boolean DEFAULT false NOT NULL;
