import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../types';

/**
 * routes/index.ts mounts many routers on /api/v1/projects, each with its own `use('*', auth)`.
 * Hono runs every matching '*' middleware for one request, so without a guard the plan rate
 * limit counted one call ~12 times (60/min became ~5/min) and API key lookups repeated as often.
 * Verification and the rate-limit hit must happen once per request.
 */

const mocks = vi.hoisted(() => ({
  redisFixedWindowHit: vi.fn(),
  validate: vi.fn(),
  isUserBanned: vi.fn(),
}));

vi.mock('../lib/redis-client', () => ({ getOptionalRedis: () => ({}) }));
vi.mock('../lib/rate-limit-redis', () => ({ redisFixedWindowHit: mocks.redisFixedWindowHit }));
vi.mock('../lib/user-ban', () => ({
  isUserBanned: mocks.isUserBanned,
  accountSuspendedError: () => new HTTPException(403, { message: 'suspended' }),
}));
vi.mock('../lib/deletion-lock', () => ({
  isAllowedWhilePendingDeletion: () => true,
  isOrganizationPendingDeletion: async () => false,
}));
vi.mock('../services/apikey.service', () => ({
  apiKeyService: { validate: mocks.validate },
  hasScope: () => true,
}));
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: { findById: async () => ({ plan: 'free' }) },
}));

const { authMiddleware, combinedAuthMiddleware } = await import('./auth');
const { generateAccessToken } = await import('../lib/jwt');

/** Same shape as routes/index.ts: two routers on one prefix, plus a nested one with its own '*' auth */
function buildApp() {
  const metrics = new Hono();
  metrics.use('*', authMiddleware);
  metrics.get('/overview', (c) => c.text('overview'));

  const logs = new Hono();
  logs.use('*', authMiddleware);
  logs.get('/:projectId/logs', (c) => c.text('logs'));

  const env = new Hono<AppEnv>();
  env.use('*', combinedAuthMiddleware);
  env.get('/', (c) => c.json({ userId: c.get('userId'), isApiKeyAuth: c.get('isApiKeyAuth') ?? false }));

  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ message: err.message }, err.status);
    return c.json({ message: 'internal' }, 500);
  });
  app.route('/api/v1/projects', metrics);
  app.route('/api/v1/projects', logs);
  app.route('/api/v1/projects/:projectId/env', env);
  return app;
}

beforeEach(() => {
  mocks.redisFixedWindowHit.mockReset();
  mocks.redisFixedWindowHit.mockImplementation(async () => ({
    count: 1,
    resetAtMs: Date.now() + 60_000,
    allowed: true,
  }));
  mocks.validate.mockReset();
  mocks.validate.mockImplementation(async (key: string) =>
    key === 'pk_live_good'
      ? { apiKey: { id: 'key-1', name: 'ci', scopes: '*' }, userId: 'user-key', organizationId: 'org-1' }
      : null,
  );
  mocks.isUserBanned.mockReset();
  mocks.isUserBanned.mockImplementation(async () => false);
});

describe('auth middleware on routers sharing a prefix', () => {
  it('session token: verifies and counts the plan rate limit once per request', async () => {
    const token = await generateAccessToken('user-1', 'org-1');

    const res = await buildApp().request('/api/v1/projects/p1/env', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'user-1', isApiKeyAuth: false });
    expect(mocks.redisFixedWindowHit).toHaveBeenCalledTimes(1);
    expect(mocks.isUserBanned).toHaveBeenCalledTimes(1);
  });

  it('API key: validates the key and counts the plan rate limit once per request', async () => {
    const res = await buildApp().request('/api/v1/projects/p1/env', {
      headers: { Authorization: 'Bearer pk_live_good' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'user-key', isApiKeyAuth: true });
    expect(mocks.validate).toHaveBeenCalledTimes(1);
    expect(mocks.redisFixedWindowHit).toHaveBeenCalledTimes(1);
    expect(mocks.redisFixedWindowHit.mock.calls[0][1]).toBe('pushify:rl:api-plan:apikey:key-1');
  });

  it('still refuses a request with a bad key or no credentials', async () => {
    const app = buildApp();

    const badKey = await app.request('/api/v1/projects/p1/env', {
      headers: { Authorization: 'Bearer pk_live_wrong' },
    });
    const none = await app.request('/api/v1/projects/p1/env');

    expect(badKey.status).toBe(401);
    expect(none.status).toBe(401);
    expect(mocks.redisFixedWindowHit).not.toHaveBeenCalled();
  });

  it('a later request is verified again (the skip does not leak across requests)', async () => {
    const app = buildApp();
    const token = await generateAccessToken('user-1', 'org-1');

    const ok = await app.request('/api/v1/projects/overview', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const anonymous = await app.request('/api/v1/projects/overview');

    expect(ok.status).toBe(200);
    expect(anonymous.status).toBe(401);
    expect(mocks.redisFixedWindowHit).toHaveBeenCalledTimes(1);
  });
});
