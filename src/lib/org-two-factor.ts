import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { organizations, users } from '../db/schema';
import { t, type SupportedLocale } from '../i18n';
import { activityService } from '../services/activity.service';

/**
 * Organization-wide two-factor policy (`organizations.require_two_factor`, owner-only toggle).
 *
 * While it is on, a user without TOTP is refused on every way into the organization, the owner
 * included, with the same code and message (`ORG_2FA_REQUIRED`):
 *  - session (JWT) requests: authMiddleware answers 403 on every organization-scoped route, except
 *    the few listed below, so the member can still fix it (set up 2FA, see their profile, sign out,
 *    move to another org);
 *  - API key requests: apiKeyAuthMiddleware answers 403 when the key's creator has no 2FA, on every
 *    route (a key cannot set up 2FA or switch organization, so nothing is exempt). Existing keys are
 *    not revoked: they work again as soon as the creator enables 2FA or the policy is turned off.
 *    New keys cannot be created either: key management is session-only (so refused above) and a CLI
 *    login collected after the policy was turned on gets no key (routes/cli-auth);
 *  - WebSocket endpoints, which verify the token themselves: `/ws` (the token's organization) and
 *    the server terminal / app shell (the organization that owns the server or project) refuse the
 *    connection when it opens. A connection already open is not cut when the policy is turned on.
 * Every refusal is written to the organization's audit log (`recordOrgTwoFactorDenial`).
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

export const ORG_2FA_REQUIRED = 'ORG_2FA_REQUIRED';

export function orgTwoFactorRequiredError(locale: SupportedLocale): HTTPException {
  return new HTTPException(403, {
    message: t(locale, 'organizations', 'twoFactorRequired'),
    cause: { code: ORG_2FA_REQUIRED },
  });
}

/** The same refusal as a WebSocket `error` frame, sent before the connection is closed (4003). */
export function orgTwoFactorRequiredWsError(locale: SupportedLocale): { type: 'error'; code: string; message: string } {
  return { type: 'error', code: ORG_2FA_REQUIRED, message: t(locale, 'organizations', 'twoFactorRequired') };
}

/** The way in that was refused, recorded as `metadata.accessPath` on the audit entry. */
export type OrgTwoFactorAccessPath =
  | 'session'
  | 'api_key'
  | 'websocket'
  | 'server_terminal'
  | 'project_shell'
  | 'cli_login';

const ACCESS_PATH_LABEL: Record<OrgTwoFactorAccessPath, string> = {
  session: 'a dashboard request',
  api_key: 'an API key request',
  websocket: 'a realtime (WebSocket) connection',
  server_terminal: 'a server terminal',
  project_shell: 'an app shell',
  cli_login: 'a CLI login key',
};

export interface OrgTwoFactorDenial {
  organizationId: string;
  userId: string;
  accessPath: OrgTwoFactorAccessPath;
  /** Request method and path (never the query: WebSocket tokens travel there). */
  method?: string;
  path?: string;
  apiKey?: { id: string; name: string };
  projectId?: string;
  serverId?: string;
  ipAddress?: string;
  userAgent?: string;
}

// A member without 2FA whose dashboard keeps polling would write one entry per request: one entry
// per user, organization and access path every 10 minutes per process is enough to see who was
// refused, where and when.
const DENIAL_AUDIT_INTERVAL_MS = 10 * 60_000;
const lastDenialAudit = new Map<string, number>();

/** Write a refusal to the organization's audit log (`auth.org_2fa_denied`), throttled as above. */
export async function recordOrgTwoFactorDenial(denial: OrgTwoFactorDenial): Promise<void> {
  const key = `${denial.organizationId}:${denial.userId}:${denial.accessPath}`;
  const now = Date.now();
  const last = lastDenialAudit.get(key);
  if (last !== undefined && now - last < DENIAL_AUDIT_INTERVAL_MS) return;
  if (lastDenialAudit.size > 10_000) lastDenialAudit.clear();
  lastDenialAudit.set(key, now);

  const metadata: Record<string, unknown> = { accessPath: denial.accessPath, code: ORG_2FA_REQUIRED };
  if (denial.method) metadata.method = denial.method;
  if (denial.path) metadata.path = denial.path;
  if (denial.serverId) metadata.serverId = denial.serverId;
  if (denial.apiKey) metadata.apiKey = { id: denial.apiKey.id, name: denial.apiKey.name };

  // activityService.log never throws: a failed audit write must not turn the 403 into a 500
  await activityService.log({
    organizationId: denial.organizationId,
    userId: denial.userId,
    projectId: denial.projectId,
    action: 'auth.org_2fa_denied',
    description: `Refused ${ACCESS_PATH_LABEL[denial.accessPath]}: the organization requires two-factor authentication`,
    metadata,
    ipAddress: denial.ipAddress,
    userAgent: denial.userAgent,
    source: denial.accessPath === 'api_key' ? 'api' : 'ui',
  });
}
