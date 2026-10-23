import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context, Next } from 'hono';

/**
 * authMiddleware lets a Pushify API key (pk_live_...) in wherever it runs. Account, 2FA, billing,
 * AI and git-provider routes have no scope check, so they must refuse an API key themselves:
 * otherwise a key scoped to `metrics:read` could set a password, enable 2FA, change the plan or
 * list private repos. Here a narrow key goes through the real authMiddleware and the real
 * rejectApiKeyAuth; a session (JWT) on the same routes still reaches the handler.
 *
 * Key lookup, rate limits, the ban/deletion checks and the services are mocked so nothing
 * touches a database, Stripe or a git provider.
 */

const { mocks, passThrough, anyService } = vi.hoisted(() => {
  const mocks = { service: vi.fn() };
  return {
    mocks,
    passThrough: async (_c: Context, next: Next) => next(),
    // Every service method answers with the same resolved value: the test is about reaching it at all.
    anyService: () => new Proxy({}, { get: () => mocks.service }),
  };
});

vi.mock('../services/apikey.service', () => ({
  apiKeyService: {
    validate: async (token: string) =>
      token.startsWith('pk_live_')
        ? { userId: 'user-1', organizationId: 'org-1', apiKey: { id: 'key-1', name: 'metrics', scopes: 'metrics:read' } }
        : null,
  },
  hasScope: (keyScopes: string, required: string) => keyScopes.split(',').includes(required),
}));
vi.mock('../middleware/rate-limit', () => ({
  authRateLimiter: passThrough,
  passwordResetRateLimiter: passThrough,
  applyPlanApiRateLimit: passThrough,
}));
vi.mock('../lib/user-ban', () => ({ isUserBanned: async () => false, accountSuspendedError: () => new Error('banned') }));
vi.mock('../lib/deletion-lock', () => ({
  isAllowedWhilePendingDeletion: () => true,
  isOrganizationPendingDeletion: async () => false,
}));
vi.mock('../middleware/require-role', () => ({ requireOrgRole: () => passThrough }));
vi.mock('../lib/org-access', () => ({ requireOrgMember: mocks.service, roleAtLeast: () => true }));
vi.mock('../db', () => ({ db: {} }));
vi.mock('../services/auth.service', () => ({ authService: anyService() }));
vi.mock('../services/organization.service', () => ({ organizationService: anyService() }));
vi.mock('../services/twoFactor.service', () => ({ twoFactorService: anyService() }));
vi.mock('../services/billing.service', () => ({ billingService: anyService() }));
vi.mock('../services/stripe.service', () => ({ stripeService: anyService() }));
vi.mock('../services/infra-billing.service', () => ({ infraBillingService: anyService() }));
vi.mock('../services/admin-notify.service', () => ({ adminNotify: vi.fn() }));
vi.mock('../services/ai.service', () => ({ aiService: { isAvailable: () => true, streamChat: mocks.service } }));
vi.mock('../services/github.service', () => ({ githubService: anyService(), hasRepoScope: () => true }));
vi.mock('../services/github-app.service', () => ({ githubAppService: anyService() }));
vi.mock('../services/gitlab.service', () => ({ gitlabService: anyService() }));

import { generateAccessToken } from '../lib/jwt';
import { authRoutes } from './auth';
import { twoFactorRoutes } from './twoFactor';
import { billingRoutes } from './billing';
import { aiRoutes } from './ai';
import { githubRoutes } from './github';
import { gitlabRoutes } from './gitlab';

type Router = { request: (path: string, init: RequestInit) => Response | Promise<Response> };

const API_KEY = 'pk_live_metrics_read_only';

function call(router: Router, method: string, path: string, token: string, body?: unknown) {
  return router.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

let session: string;

beforeEach(async () => {
  mocks.service.mockReset().mockResolvedValue({ id: 'user-1', email: 'user@example.com', name: 'User', avatarUrl: null });
  session ??= await generateAccessToken('user-1', 'org-1');
});

describe('API keys on account routes (/auth/me)', () => {
  it('refuses a narrow key changing the password, but lets a session do it and the key read /me', async () => {
    const res = await call(authRoutes, 'POST', '/me/change-password', API_KEY, { newPassword: 'NewSecurePass123' });
    expect(res.status).toBe(403);
    expect(mocks.service).not.toHaveBeenCalled();

    expect((await call(authRoutes, 'PATCH', '/me', API_KEY, { name: 'Taken Over' })).status).toBe(403);
    expect((await call(authRoutes, 'POST', '/me/deletion', API_KEY, { confirmEmail: 'user@example.com' })).status).toBe(403);
    expect(mocks.service).not.toHaveBeenCalled();

    expect((await call(authRoutes, 'GET', '/me', API_KEY)).status).toBe(200);
    expect((await call(authRoutes, 'POST', '/me/change-password', session, { newPassword: 'NewSecurePass123' })).status).toBe(200);
  });
});

describe('API keys on 2FA routes (/auth/2fa)', () => {
  it('refuses a key on every 2FA route, reads included', async () => {
    expect((await call(twoFactorRoutes, 'POST', '/setup', API_KEY)).status).toBe(403);
    expect((await call(twoFactorRoutes, 'GET', '/status', API_KEY)).status).toBe(403);
    expect(mocks.service).not.toHaveBeenCalled();

    expect((await call(twoFactorRoutes, 'POST', '/setup', session)).status).toBe(200);
  });
});

describe('API keys on billing routes (/billing)', () => {
  it('refuses a key changing the plan, paying or cancelling, but lets it read and lets a session write', async () => {
    const res = await call(billingRoutes, 'POST', '/change-plan', API_KEY, { planType: 'business', billingCycle: 'monthly' });
    expect(res.status).toBe(403);
    for (const path of ['/pay-outstanding', '/cancel', '/portal']) {
      expect((await call(billingRoutes, 'POST', path, API_KEY)).status).toBe(403);
    }
    expect(mocks.service).not.toHaveBeenCalled();

    expect((await call(billingRoutes, 'GET', '/subscription', API_KEY)).status).toBe(200);
    expect((await call(billingRoutes, 'POST', '/cancel', session)).status).toBe(200);
  });
});

describe('API keys on AI routes (/ai)', () => {
  it('refuses a key on every AI route', async () => {
    expect((await call(aiRoutes, 'GET', '/status', API_KEY)).status).toBe(403);
    expect((await call(aiRoutes, 'POST', '/chat', API_KEY, { messages: [{ role: 'user', content: 'hi' }] })).status).toBe(403);
    expect(mocks.service).not.toHaveBeenCalled();

    expect((await call(aiRoutes, 'GET', '/status', session)).status).toBe(200);
  });
});

describe('API keys on git provider routes (/integrations/github, /integrations/gitlab)', () => {
  it('refuses a key on GitHub, reads included', async () => {
    expect((await call(githubRoutes, 'GET', '/repos', API_KEY)).status).toBe(403);
    expect((await call(githubRoutes, 'GET', '/status', API_KEY)).status).toBe(403);
    expect(mocks.service).not.toHaveBeenCalled();

    expect((await call(githubRoutes, 'GET', '/status', session)).status).toBe(200);
  });

  it('refuses a key on GitLab, reads included', async () => {
    expect((await call(gitlabRoutes, 'GET', '/repos', API_KEY)).status).toBe(403);
    expect((await call(gitlabRoutes, 'GET', '/status', API_KEY)).status).toBe(403);
    expect(mocks.service).not.toHaveBeenCalled();

    expect((await call(gitlabRoutes, 'GET', '/status', session)).status).toBe(200);
  });
});
