import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono, type Context } from 'hono';

/**
 * Purchased domains (/api/v1/domains): an API key needs domains:read to read and domains:write to
 * change anything. Nameservers, the registrar lock, DNS records and email forwards decide who
 * controls the domain and its mail, so a key scoped to something else (metrics:read for CI) must
 * not reach them. Buying, transferring and the transfer-out code stay session-only.
 *
 * The real authMiddleware runs, so a `pk_live_` token takes the same path as in production
 * (authMiddleware → apiKeyAuthMiddleware). Key validation, the JWT check, the role lookup and the
 * services behind the routes are mocked, so nothing touches a database or a registrar.
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
vi.mock('../lib/org-two-factor', () => ({
  isExemptFromOrgTwoFactor: () => true,
  isOrganizationTwoFactorRequired: async () => false,
  userHasTwoFactorEnabled: async () => true,
  orgTwoFactorRequiredError: () => new Error('2fa required'),
}));
vi.mock('../middleware/rate-limit', () => ({
  applyPlanApiRateLimit: pass,
  domainPublicSearchRateLimiter: pass,
}));
vi.mock('../lib/org-access', () => ({ requireMinRole: () => pass }));
vi.mock('../services/registrar-domain.service', () => ({
  MAX_PURCHASE_YEARS: 10,
  registrarDomainService: serviceProxy(),
}));
vi.mock('../services/billing.service', () => ({ billingService: serviceProxy() }));
vi.mock('../services/stripe.service', () => ({ stripeService: serviceProxy() }));

import { errorHandler } from '../middleware/error-handler';
import { t } from '../i18n';
import { registrarDomainRoutes } from './registrar-domains';

// Same mount point as routes/index.ts
const app = new Hono();
app.route('/api/v1/domains', registrarDomainRoutes);
app.onError((err, c) => errorHandler(err, c as Context));

const KEYS: Record<string, string> = {
  pk_live_metrics_only: 'metrics:read',
  pk_live_domains_read: 'domains:read',
  pk_live_domains_write: 'domains:read,domains:write',
};
const SESSION = 'session-access-token';
const INSUFFICIENT_SCOPE = t('en', 'apiKeys', 'insufficientScope');
const SESSION_ONLY = t('en', 'apiKeys', 'sessionOnly');

const call = (method: string, path: string, token: string | null, body?: unknown) =>
  app.request(`/api/v1/domains${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function expectRefused(res: Response, message: string) {
  expect(res.status).toBe(403);
  const json = (await res.json()) as { error: { message: string } };
  expect(json.error.message).toBe(message);
}

// Every route that changes a purchased domain, with a valid body.
const WRITES: [string, string, unknown?][] = [
  ['POST', '/example.com/nameservers', { nameservers: ['ns1.attacker.net', 'ns2.attacker.net'] }],
  ['POST', '/example.com/lock', { locked: false }],
  ['POST', '/example.com/dns', { type: 'MX', host: '@', answer: 'mx.attacker.net', priority: 1 }],
  ['PUT', '/example.com/dns/rec-1', { type: 'A', host: '@', answer: '203.0.113.7' }],
  ['DELETE', '/example.com/dns/rec-1'],
  ['POST', '/example.com/email-forwarding', { emailBox: 'billing', emailTo: 'thief@attacker.net' }],
  ['DELETE', '/example.com/email-forwarding/billing'],
  ['PATCH', '/example.com/auto-renew', { enabled: false }],
];

const READS = ['', '/search?q=example', '/example.com/details', '/example.com/dns', '/example.com/email-forwarding'];

beforeEach(() => {
  h.validate.mockReset().mockImplementation(async (token: string) =>
    token in KEYS
      ? { userId: 'user-1', organizationId: 'org-1', apiKey: { id: 'key-1', name: 'ci', scopes: KEYS[token] } }
      : null
  );
  h.verifyToken.mockReset().mockImplementation(async (token: string) => {
    if (token !== SESSION) throw new Error('invalid');
    return { type: 'access', sub: 'user-1', org: 'org-1' };
  });
  h.service.mockReset().mockResolvedValue({ id: 'd1', domainName: 'example.com' });
});

describe('purchased domains with a key without domain scopes', () => {
  it.each(WRITES)('refuses %s %s and calls no service', async (method, path, body) => {
    await expectRefused(await call(method, path, 'pk_live_metrics_only', body), INSUFFICIENT_SCOPE);
    expect(h.service).not.toHaveBeenCalled();
  });

  it('refuses the reads too', async () => {
    for (const path of READS) {
      await expectRefused(await call('GET', path, 'pk_live_metrics_only'), INSUFFICIENT_SCOPE);
    }
    expect(h.service).not.toHaveBeenCalled();
  });
});

describe('purchased domains with a domains:read key', () => {
  it('reads the domains and their DNS', async () => {
    h.service.mockResolvedValue([]);
    for (const path of READS) {
      expect((await call('GET', path, 'pk_live_domains_read')).status).toBe(200);
    }
  });

  it.each(WRITES)('refuses %s %s', async (method, path, body) => {
    await expectRefused(await call(method, path, 'pk_live_domains_read', body), INSUFFICIENT_SCOPE);
    expect(h.service).not.toHaveBeenCalled();
  });
});

describe('purchased domains with a domains:write key', () => {
  it.each(WRITES)('allows %s %s', async (method, path, body) => {
    const res = await call(method, path, 'pk_live_domains_write', body);
    expect([200, 201]).toContain(res.status);
    expect(h.service).toHaveBeenCalledTimes(1);
    expect(h.service.mock.calls[0]?.slice(0, 2)).toEqual(['org-1', 'example.com']);
  });

  it('still cannot buy, transfer in or take the transfer-out code', async () => {
    await expectRefused(await call('POST', '/purchase', 'pk_live_domains_write', { domainName: 'example.com' }), SESSION_ONLY);
    await expectRefused(await call('POST', '/purchase/checkout', 'pk_live_domains_write', { domainName: 'example.com' }), SESSION_ONLY);
    await expectRefused(await call('POST', '/transfer', 'pk_live_domains_write', { domainName: 'example.com', authCode: 'x' }), SESSION_ONLY);
    await expectRefused(await call('POST', '/example.com/auth-code', 'pk_live_domains_write'), SESSION_ONLY);
    expect(h.service).not.toHaveBeenCalled();
  });
});

describe('purchased domains with a dashboard session', () => {
  it.each(WRITES)('allows %s %s as before', async (method, path, body) => {
    const res = await call(method, path, SESSION, body);
    expect([200, 201]).toContain(res.status);
    expect(h.service).toHaveBeenCalledTimes(1);
  });

  it('reads as before', async () => {
    h.service.mockResolvedValue([]);
    for (const path of READS) {
      expect((await call('GET', path, SESSION)).status).toBe(200);
    }
  });
});

describe('public availability search', () => {
  it('stays open without any credentials', async () => {
    h.service.mockResolvedValue([]);
    const res = await call('GET', '/public-search?q=example', null);
    expect(res.status).toBe(200);
    expect(h.validate).not.toHaveBeenCalled();
    expect(h.verifyToken).not.toHaveBeenCalled();
  });
});
