import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono, type Context } from 'hono';

/**
 * An API key is a narrow, scoped credential. It must not change the account it belongs to
 * (password, 2FA, sessions), move money (plan changes, payments, cancellation, the Stripe
 * portal), or reach the owner's Git accounts and the AI assistant. These routers have no
 * requireScope, so they refuse API keys outright: writes everywhere, and every method on 2FA,
 * AI, GitHub and GitLab.
 *
 * The real authMiddleware runs, so a `pk_live_` token takes the same path as in production
 * (authMiddleware → apiKeyAuthMiddleware). Only key validation, the JWT check and the services
 * behind the routes are mocked, so nothing touches a database or Stripe.
 */
const { h, pass, serviceProxy } = vi.hoisted(() => {
  const h = { validate: vi.fn(), verifyToken: vi.fn(), service: vi.fn() };
  return {
    h,
    pass: async (_c: unknown, next: () => Promise<void>) => next(),
    // Every service method is the same spy: the test is about reaching it at all.
    serviceProxy: () => new Proxy({}, { get: () => h.service }),
  };
});

vi.mock('../services/apikey.service', () => ({
  apiKeyService: { validate: h.validate },
  hasScope: (keyScopes: string, required: string) => keyScopes === '*' || keyScopes.split(',').includes(required),
}));
vi.mock('../lib/jwt', () => ({ verifyToken: h.verifyToken }));
vi.mock('../lib/user-ban', () => ({ isUserBanned: async () => false, accountSuspendedError: () => new Error('banned') }));
vi.mock('../lib/deletion-lock', () => ({
  isAllowedWhilePendingDeletion: () => true,
  isOrganizationPendingDeletion: async () => false,
}));
vi.mock('../middleware/rate-limit', () => ({
  applyPlanApiRateLimit: pass,
  authRateLimiter: pass,
  passwordResetRateLimiter: pass,
}));
vi.mock('../middleware/require-role', () => ({ requireOrgRole: () => pass }));
vi.mock('../lib/org-access', () => ({ requireOrgMember: h.service, roleAtLeast: () => true }));
vi.mock('../lib/oauth-state-store', () => ({
  createOAuthState: h.service,
  consumeOAuthState: h.service,
  validateOAuthStateRecord: () => false,
}));
vi.mock('../services/auth.service', () => ({ authService: serviceProxy() }));
vi.mock('../services/organization.service', () => ({ organizationService: serviceProxy() }));
vi.mock('../services/twoFactor.service', () => ({ twoFactorService: serviceProxy() }));
vi.mock('../services/billing.service', () => ({ billingService: serviceProxy() }));
vi.mock('../services/stripe.service', () => ({ stripeService: serviceProxy() }));
vi.mock('../services/infra-billing.service', () => ({ infraBillingService: serviceProxy() }));
vi.mock('../services/admin-notify.service', () => ({ adminNotify: serviceProxy() }));
vi.mock('../services/ai.service', () => ({ aiService: { isAvailable: () => true, streamChat: h.service } }));
vi.mock('../services/github.service', () => ({ githubService: serviceProxy(), hasRepoScope: () => true }));
vi.mock('../services/github-app.service', () => ({ githubAppService: serviceProxy() }));
vi.mock('../services/gitlab.service', () => ({ gitlabService: serviceProxy() }));

import { errorHandler } from '../middleware/error-handler';
import { t } from '../i18n';
import { authRoutes } from './auth';
import { twoFactorRoutes } from './twoFactor';
import { billingRoutes } from './billing';
import { aiRoutes } from './ai';
import { githubRoutes } from './github';
import { gitlabRoutes } from './gitlab';
import { onboardingRoutes } from './onboarding';

// Same mount points and order as routes/index.ts: authRoutes, twoFactorRoutes and
// onboardingRoutes share /auth, so authRoutes' /me/* middleware covers onboarding's /me routes.
const app = new Hono();
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/auth/2fa', twoFactorRoutes);
app.route('/api/v1/billing', billingRoutes);
app.route('/api/v1/auth', onboardingRoutes);
app.route('/api/v1/ai', aiRoutes);
app.route('/api/v1/integrations/github', githubRoutes);
app.route('/api/v1/integrations/gitlab', gitlabRoutes);
app.onError((err, c) => errorHandler(err, c as Context));

const API_KEY = 'pk_live_metrics_only';
const SESSION = 'session-access-token';
const SESSION_ONLY = t('en', 'apiKeys', 'sessionOnly');

const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const withKey = (method: string, path: string, body?: unknown) =>
  call(method, path, { Authorization: `Bearer ${API_KEY}` }, body);
const withSession = (method: string, path: string, body?: unknown) =>
  call(method, path, { Authorization: `Bearer ${SESSION}` }, body);

async function expectSessionOnly(res: Response) {
  expect(res.status).toBe(403);
  const json = (await res.json()) as { error: { message: string } };
  expect(json.error.message).toBe(SESSION_ONLY);
}

beforeEach(() => {
  h.validate.mockReset().mockImplementation(async (token: string) =>
    token === API_KEY
      ? { userId: 'user-1', organizationId: 'org-1', apiKey: { id: 'key-1', name: 'metrics', scopes: 'metrics:read' } }
      : null
  );
  h.verifyToken.mockReset().mockImplementation(async (token: string) => {
    if (token !== SESSION) throw new Error('invalid');
    return { type: 'access', sub: 'user-1', org: 'org-1' };
  });
  h.service.mockReset().mockResolvedValue({
    id: 'user-1',
    email: 'owner@example.com',
    name: 'Owner',
    avatarUrl: null,
    emailVerified: true,
    twoFactorEnabled: false,
    hasPassword: false,
    createdAt: new Date(0),
    message: 'ok',
    secret: 'secret',
    qrCodeUrl: 'otpauth://totp/x',
    backupCodes: [],
  });
});

describe('authRouter /me with an API key', () => {
  it('refuses POST /auth/me/change-password and sets no password', async () => {
    await expectSessionOnly(await withKey('POST', '/auth/me/change-password', { newPassword: 'TakenOver123' }));
    expect(h.service).not.toHaveBeenCalled();
  });

  it('refuses the other account writes under /me', async () => {
    await expectSessionOnly(await withKey('PATCH', '/auth/me', { name: 'Someone Else' }));
    await expectSessionOnly(await withKey('DELETE', '/auth/me/sessions/11111111-1111-4111-8111-111111111111'));
    await expectSessionOnly(await withKey('POST', '/auth/me/sessions/terminate-others', { refreshToken: 'r' }));
    await expectSessionOnly(await withKey('POST', '/auth/me/deletion', { confirmEmail: 'owner@example.com' }));
    await expectSessionOnly(await withKey('PUT', '/auth/me/notification-prefs', { securityAlerts: false }));
    expect(h.service).not.toHaveBeenCalled();
  });

  it('refuses the key sent as X-API-Key too', async () => {
    await expectSessionOnly(
      await call('POST', '/auth/me/change-password', { 'X-API-Key': API_KEY }, { newPassword: 'TakenOver123' })
    );
  });

  it('still lets the key read GET /auth/me', async () => {
    const res = await withKey('GET', '/auth/me');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { id: string } }).data.id).toBe('user-1');
  });

  it('leaves a dashboard session free to change the password', async () => {
    const res = await withSession('POST', '/auth/me/change-password', { newPassword: 'NewSecurePass123' });
    expect(res.status).toBe(200);
    expect(h.service.mock.calls[0]?.slice(0, 2)).toEqual(['user-1', { newPassword: 'NewSecurePass123' }]);
  });
});

describe('twoFactorRouter with an API key', () => {
  it('refuses POST /auth/2fa/setup and generates no secret', async () => {
    await expectSessionOnly(await withKey('POST', '/auth/2fa/setup'));
    expect(h.service).not.toHaveBeenCalled();
  });

  it('refuses enable, disable, backup codes and status', async () => {
    await expectSessionOnly(await withKey('POST', '/auth/2fa/enable', { code: '123456', backupCodes: Array(8).fill('abcd1234') }));
    await expectSessionOnly(await withKey('POST', '/auth/2fa/disable', {}));
    await expectSessionOnly(await withKey('POST', '/auth/2fa/backup-codes/regenerate', {}));
    await expectSessionOnly(await withKey('GET', '/auth/2fa/status'));
    expect(h.service).not.toHaveBeenCalled();
  });

  it('leaves a dashboard session free to set up 2FA', async () => {
    const res = await withSession('POST', '/auth/2fa/setup');
    expect(res.status).toBe(200);
  });
});

describe('billingRouter with an API key', () => {
  it('refuses POST /billing/change-plan and charges nothing', async () => {
    await expectSessionOnly(await withKey('POST', '/billing/change-plan', { planType: 'business', billingCycle: 'yearly' }));
    expect(h.service).not.toHaveBeenCalled();
  });

  it('refuses payments, cancellation, the portal and the billing email', async () => {
    for (const path of ['/billing/pay-outstanding', '/billing/cancel', '/billing/portal', '/billing/payment-method', '/billing/checkout', '/billing/infra/topup']) {
      await expectSessionOnly(await withKey('POST', path, {}));
    }
    await expectSessionOnly(await withKey('PATCH', '/billing/email', { billingEmail: 'attacker@example.com' }));
    expect(h.service).not.toHaveBeenCalled();
  });

  it('still lets the key read GET /billing', async () => {
    expect((await withKey('GET', '/billing')).status).toBe(200);
  });

  it('leaves a dashboard session free to cancel', async () => {
    expect((await withSession('POST', '/billing/cancel')).status).toBe(200);
    expect(h.service).toHaveBeenCalledWith('org-1');
  });
});

describe('AI, GitHub and GitLab routers with an API key', () => {
  it('refuses the AI assistant', async () => {
    await expectSessionOnly(await withKey('GET', '/ai/status'));
    await expectSessionOnly(await withKey('POST', '/ai/chat', { messages: [{ role: 'user', content: 'hi' }] }));
    expect((await withSession('GET', '/ai/status')).status).toBe(200);
  });

  it('refuses GitHub, so private repositories cannot be listed', async () => {
    await expectSessionOnly(await withKey('GET', '/integrations/github/repos'));
    await expectSessionOnly(await withKey('GET', '/integrations/github/status'));
    await expectSessionOnly(await withKey('GET', '/integrations/github/app/installations'));
    await expectSessionOnly(await withKey('DELETE', '/integrations/github/disconnect'));
    expect(h.service).not.toHaveBeenCalled();
  });

  it('refuses GitLab', async () => {
    await expectSessionOnly(await withKey('GET', '/integrations/gitlab/repos'));
    await expectSessionOnly(await withKey('GET', '/integrations/gitlab/status'));
    await expectSessionOnly(await withKey('DELETE', '/integrations/gitlab/disconnect'));
    expect(h.service).not.toHaveBeenCalled();
  });
});
