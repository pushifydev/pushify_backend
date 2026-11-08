import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * Organization-wide 2FA in authMiddleware: while an organization requires it, a session whose user
 * has no TOTP gets 403 ORG_2FA_REQUIRED on the organization's routes, except the ones needed to fix
 * that. An API key whose creator has no TOTP gets the same 403 on every route. Each refusal is
 * written to the audit log.
 */

const mocks = vi.hoisted(() => ({
  required: vi.fn(),
  hasTwoFactor: vi.fn(),
  validate: vi.fn(),
  denied: vi.fn(),
}));

vi.mock('../lib/redis-client', () => ({ getOptionalRedis: () => null }));
vi.mock('../lib/user-ban', () => ({
  isUserBanned: async () => false,
  accountSuspendedError: () => new HTTPException(403, { message: 'suspended' }),
}));
vi.mock('../lib/deletion-lock', () => ({
  isAllowedWhilePendingDeletion: () => true,
  isOrganizationPendingDeletion: async () => false,
}));
// Real exemption list and error; only the two database reads and the audit write are replaced
vi.mock('../lib/org-two-factor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/org-two-factor')>()),
  isOrganizationTwoFactorRequired: mocks.required,
  userHasTwoFactorEnabled: mocks.hasTwoFactor,
  recordOrgTwoFactorDenial: mocks.denied,
}));
vi.mock('../services/apikey.service', () => ({
  apiKeyService: { validate: mocks.validate },
  hasScope: () => true,
}));
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: { findById: async () => ({ plan: 'free' }) },
}));

const { authMiddleware, combinedAuthMiddleware } = await import('./auth');
const { errorHandler } = await import('./error-handler');
const { generateAccessToken } = await import('../lib/jwt');

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  const ok = (c: { text: (s: string) => Response }) => c.text('ok');

  // Organization-scoped
  app.use('/api/v1/projects/*', combinedAuthMiddleware);
  app.get('/api/v1/projects/p1', ok);
  app.post('/api/v1/projects/p1/deployments', ok);
  app.use('/api/v1/organizations/*', authMiddleware);
  app.get('/api/v1/organizations/members', ok);
  app.put('/api/v1/organizations/two-factor-policy', ok);
  // Exempt
  app.use('/api/v1/auth/*', authMiddleware);
  app.post('/api/v1/auth/2fa/setup', ok);
  app.post('/api/v1/auth/2fa/enable', ok);
  app.get('/api/v1/auth/2fa/status', ok);
  app.get('/api/v1/auth/me', ok);
  app.patch('/api/v1/auth/me', ok);
  app.get('/api/v1/auth/me/sessions', ok);
  app.post('/api/v1/auth/logout', ok);
  app.post('/api/v1/organizations/switch', ok);
  app.get('/api/v1/organizations/mine', ok);
  return app;
}

async function session(userId = 'user-1', orgId: string | null = 'org-1') {
  return { Authorization: `Bearer ${await generateAccessToken(userId, orgId ?? undefined)}` };
}

beforeEach(() => {
  mocks.required.mockReset();
  mocks.required.mockResolvedValue(true);
  mocks.hasTwoFactor.mockReset();
  mocks.hasTwoFactor.mockResolvedValue(false);
  mocks.validate.mockReset();
  mocks.validate.mockImplementation(async (key: string) =>
    key === 'pk_live_good'
      ? { apiKey: { id: 'key-1', name: 'ci', scopes: '*' }, userId: 'user-1', organizationId: 'org-1' }
      : null,
  );
  mocks.denied.mockReset();
  mocks.denied.mockResolvedValue(undefined);
});

describe('organization-wide 2FA in authMiddleware', () => {
  it('lets a member with 2FA through', async () => {
    mocks.hasTwoFactor.mockResolvedValue(true);
    const app = buildApp();

    const read = await app.request('/api/v1/projects/p1', { headers: await session() });
    const write = await app.request('/api/v1/projects/p1/deployments', { method: 'POST', headers: await session() });

    expect(read.status).toBe(200);
    expect(write.status).toBe(200);
    expect(mocks.required).toHaveBeenCalledWith('org-1');
    expect(mocks.hasTwoFactor).toHaveBeenCalledWith('user-1');
  });

  it('refuses a member without 2FA with 403 ORG_2FA_REQUIRED, reads and writes alike', async () => {
    const app = buildApp();

    for (const [method, path] of [
      ['GET', '/api/v1/projects/p1'],
      ['POST', '/api/v1/projects/p1/deployments'],
      ['GET', '/api/v1/organizations/members'],
      ['PUT', '/api/v1/organizations/two-factor-policy'],
    ] as const) {
      const res = await app.request(path, { method, headers: await session() });
      expect(res.status, `${method} ${path}`).toBe(403);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('ORG_2FA_REQUIRED');
      expect(body.error.message).toMatch(/two-factor/i);
    }
  });

  it('writes the refused session to the audit log', async () => {
    await buildApp().request('/api/v1/projects/p1/deployments', {
      method: 'POST',
      headers: { ...(await session()), 'x-forwarded-for': '203.0.113.7', 'user-agent': 'browser' },
    });

    expect(mocks.denied).toHaveBeenCalledTimes(1);
    expect(mocks.denied).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'user-1',
      accessPath: 'session',
      method: 'POST',
      path: '/api/v1/projects/p1/deployments',
      ipAddress: '203.0.113.7',
      userAgent: 'browser',
    });
  });

  it('keeps profile, 2FA setup, logout and switching organization open', async () => {
    const app = buildApp();

    for (const [method, path] of [
      ['POST', '/api/v1/auth/2fa/setup'],
      ['POST', '/api/v1/auth/2fa/enable'],
      ['GET', '/api/v1/auth/2fa/status'],
      ['GET', '/api/v1/auth/me'],
      ['PATCH', '/api/v1/auth/me'],
      ['GET', '/api/v1/auth/me/sessions'],
      ['POST', '/api/v1/auth/logout'],
      ['POST', '/api/v1/organizations/switch'],
      ['GET', '/api/v1/organizations/mine'],
    ] as const) {
      const res = await app.request(path, { method, headers: await session() });
      expect(res.status, `${method} ${path}`).toBe(200);
    }
    expect(mocks.hasTwoFactor).not.toHaveBeenCalled();
    expect(mocks.denied).not.toHaveBeenCalled();
  });

  it('does nothing while the organization does not require it', async () => {
    mocks.required.mockResolvedValue(false);

    const res = await buildApp().request('/api/v1/projects/p1', { headers: await session() });

    expect(res.status).toBe(200);
    expect(mocks.hasTwoFactor).not.toHaveBeenCalled();
    expect(mocks.denied).not.toHaveBeenCalled();
  });

  it('does not check a session without an organization', async () => {
    const res = await buildApp().request('/api/v1/projects/p1', { headers: await session('user-1', null) });

    expect(res.status).toBe(200);
    expect(mocks.required).not.toHaveBeenCalled();
  });
});

describe('organization-wide 2FA for API keys', () => {
  const keyHeaders: Record<string, string>[] = [
    { 'X-API-Key': 'pk_live_good' },
    { Authorization: 'Bearer pk_live_good' },
  ];

  it("refuses a key whose creator has no 2FA with 403 ORG_2FA_REQUIRED, through every middleware", async () => {
    const app = buildApp();

    for (const headers of keyHeaders) {
      for (const [method, path] of [
        ['GET', '/api/v1/projects/p1'], // combinedAuthMiddleware
        ['POST', '/api/v1/projects/p1/deployments'],
        ['GET', '/api/v1/organizations/members'], // authMiddleware
      ] as const) {
        const res = await app.request(path, { method, headers });
        expect(res.status, `${method} ${path}`).toBe(403);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('ORG_2FA_REQUIRED');
        expect(body.error.message).toMatch(/Settings → Security/);
      }
    }
    expect(mocks.required).toHaveBeenCalledWith('org-1');
    expect(mocks.hasTwoFactor).toHaveBeenCalledWith('user-1');
  });

  it('exempts no route for a key (it cannot set up 2FA or switch organization)', async () => {
    const app = buildApp();

    for (const [method, path] of [
      ['GET', '/api/v1/auth/me'],
      ['GET', '/api/v1/auth/2fa/status'],
      ['POST', '/api/v1/organizations/switch'],
      ['GET', '/api/v1/organizations/mine'],
    ] as const) {
      const res = await app.request(path, { method, headers: { 'X-API-Key': 'pk_live_good' } });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('gives a key the same error body as a refused session', async () => {
    const res = await buildApp().request('/api/v1/projects/p1', {
      headers: { 'X-API-Key': 'pk_live_good' },
    });
    const sessionRes = await buildApp().request('/api/v1/projects/p1', { headers: await session() });

    expect(await res.json()).toEqual(await sessionRes.json());
  });

  it('writes the refused key request to the audit log, naming the key', async () => {
    await buildApp().request('/api/v1/projects/p1', {
      headers: { 'X-API-Key': 'pk_live_good', 'x-real-ip': '198.51.100.4', 'user-agent': 'ci-runner' },
    });

    expect(mocks.denied).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'user-1',
      accessPath: 'api_key',
      method: 'GET',
      path: '/api/v1/projects/p1',
      apiKey: { id: 'key-1', name: 'ci' },
      ipAddress: '198.51.100.4',
      userAgent: 'ci-runner',
    });
  });

  it('lets a key through when its creator has 2FA', async () => {
    mocks.hasTwoFactor.mockResolvedValue(true);
    const app = buildApp();

    for (const headers of keyHeaders) {
      expect((await app.request('/api/v1/projects/p1', { headers })).status).toBe(200);
    }
    expect(mocks.denied).not.toHaveBeenCalled();
  });

  it('lets a key through while its organization does not require it', async () => {
    mocks.required.mockResolvedValue(false);

    const res = await buildApp().request('/api/v1/projects/p1', { headers: { 'X-API-Key': 'pk_live_good' } });

    expect(res.status).toBe(200);
    expect(mocks.hasTwoFactor).not.toHaveBeenCalled();
    expect(mocks.denied).not.toHaveBeenCalled();
  });

  it('still answers 401 for an unknown key, before any 2FA check', async () => {
    const res = await buildApp().request('/api/v1/projects/p1', { headers: { 'X-API-Key': 'pk_live_bad' } });

    expect(res.status).toBe(401);
    expect(mocks.required).not.toHaveBeenCalled();
  });
});
