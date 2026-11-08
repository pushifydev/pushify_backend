-- Organization-wide 2FA now covers API keys and the WebSocket endpoints too, and every refusal of
-- a member without 2FA (any access path) goes to the audit log. Additive enum value only.
ALTER TYPE "public"."activity_action" ADD VALUE IF NOT EXISTS 'auth.org_2fa_denied';
