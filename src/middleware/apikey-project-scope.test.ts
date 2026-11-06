import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * A key limited to projects (api_keys.project_ids) goes through the real authMiddleware →
 * apiKeyAuthMiddleware path. It only reaches the project API of its own projects; the rest of the
 * request runs with the key's list in the async context, where lib/member-project-scope reads it.
 * Only key validation and the rate limit are mocked.
 */
const { h } = vi.hoisted(() => ({ h: { validate: vi.fn() } }));

vi.mock('../services/apikey.service', () => ({
  apiKeyService: { validate: h.validate },
  hasScope: (keyScopes: string, required: string) => keyScopes === '*' || keyScopes.split(',').includes(required),
}));
vi.mock('../lib/jwt', () => ({ verifyToken: vi.fn() }));
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
vi.mock('./rate-limit', () => ({
  applyPlanApiRateLimit: async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { authMiddleware } from './auth';
import { errorHandler } from './error-handler';
import { currentApiKeyProjectIds } from '../lib/api-key-project-scope';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('/api/v1/*', authMiddleware);
  app.all('/api/v1/*', (c) => c.json({ reached: true, keyProjects: currentApiKeyProjectIds() }));
  return app;
}

function keyWith(projectIds: string[] | null) {
  h.validate.mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    apiKey: { id: 'key-1', name: 'ci', scopes: '*', projectIds },
  });
}

async function call(method: string, path: string) {
  const res = await buildApp().request(path, { method, headers: { Authorization: 'Bearer pk_live_test' } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  h.validate.mockReset();
});

describe('a project-scoped API key', () => {
  beforeEach(() => keyWith([A]));

  it('reaches its own project, with the list in the request context', async () => {
    const res = await call('POST', `/api/v1/projects/${A}/deployments`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true, keyProjects: [A] });
  });

  it('lists projects (filtered later by the member scope helpers)', async () => {
    const res = await call('GET', '/api/v1/projects');
    expect(res.status).toBe(200);
    expect(res.body.keyProjects).toEqual([A]);
  });

  it('gets 404 for another project, so it cannot be probed', async () => {
    const res = await call('GET', `/api/v1/projects/${B}`);
    expect(res.status).toBe(404);
    expect(res.body.reached).toBeUndefined();
  });

  it('gets 403 outside the project API and when creating a project', async () => {
    for (const [method, path] of [
      ['GET', '/api/v1/servers'],
      ['GET', '/api/v1/databases'],
      ['GET', '/api/v1/dashboard/overview'],
      ['GET', '/api/v1/organizations'],
      ['POST', '/api/v1/projects'],
    ] as const) {
      const res = await call(method, path);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.reached).toBeUndefined();
    }
  });
});

describe('an unscoped API key', () => {
  it('is not affected', async () => {
    keyWith(null);
    for (const path of ['/api/v1/servers', `/api/v1/projects/${B}`, '/api/v1/projects']) {
      const res = await call('GET', path);
      expect(res.status, path).toBe(200);
      expect(res.body).toEqual({ reached: true, keyProjects: null });
    }
  });
});
