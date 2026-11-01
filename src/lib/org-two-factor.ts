import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { organizations, users } from '../db/schema';
import { t, type SupportedLocale } from '../i18n';

/**
 * Organization-wide two-factor policy (`organizations.require_two_factor`, owner-only toggle).
 *
 * While it is on, the auth middleware refuses a session (JWT) whose user has no TOTP enabled on
 * every organization-scoped route with 403 `ORG_2FA_REQUIRED` — except the few listed below, so
 * the member can still fix it (set up 2FA, see their profile, sign out, move to another org).
 * The policy applies to everyone in the organization, the owner included.
 *
 * API keys are NOT affected in this step: they never reach the session branch of the middleware.
 * A key keeps working for the user who created it even if that user has no 2FA.
 *
 * Enforced SSO: signing in through the identity provider does not satisfy this policy. SSO says
 * who the person is; the second factor is Pushify's own TOTP (sso.service already asks for it
 * after the provider when the user has it). A member of an SSO-enforced organization that also
 * requires 2FA therefore signs in through the provider and must still enable TOTP here.
 */

// The policy is read on every signed-in request, so it is cached briefly per process (as the
// deletion lock is). The user's own 2FA flag is not cached: it is only read while the policy is
// on, and a member who just enabled 2FA must get in straight away.
const TTL_MS = 30_000;
const cache = new Map<string, { required: boolean; at: number }>();

export async function isOrganizationTwoFactorRequired(organizationId: string): Promise<boolean> {
  const hit = cache.get(organizationId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.required;
  const [row] = await db
    .select({ requireTwoFactor: organizations.requireTwoFactor })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  const required = !!row?.requireTwoFactor;
  cache.set(organizationId, { required, at: Date.now() });
  if (cache.size > 10_000) cache.clear();
  return required;
}

/** Call after turning the policy on or off; other processes catch up within the TTL. */
export function invalidateOrgTwoFactorPolicy(organizationId: string): void {
  cache.delete(organizationId);
}

export async function userHasTwoFactorEnabled(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ twoFactorEnabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return !!row?.twoFactorEnabled;
}

/** Routes a member without 2FA can still use, whatever the method. */
const EXEMPT_FROM_ORG_TWO_FACTOR: RegExp[] = [
  /^\/api\/v1\/auth\/2fa(?:\/.*)?$/, // set up, enable, status
  /^\/api\/v1\/auth\/me(?:\/.*)?$/, // profile, password, sessions, own account deletion
  /^\/api\/v1\/auth\/logout$/,
  /^\/api\/v1\/organizations\/switch$/, // move to an organization that does not require it
  /^\/api\/v1\/organizations\/mine$/, // the switcher's list of organizations
];

export function isExemptFromOrgTwoFactor(path: string): boolean {
  return EXEMPT_FROM_ORG_TWO_FACTOR.some((re) => re.test(path));
}

export function orgTwoFactorRequiredError(locale: SupportedLocale): HTTPException {
  return new HTTPException(403, {
    message: t(locale, 'organizations', 'twoFactorRequired'),
    cause: { code: 'ORG_2FA_REQUIRED' },
  });
}
