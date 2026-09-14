import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import type { Context, Next } from 'hono';

/**
 * The admin API exposes every customer's data to whoever gets through the gate, so the gate
 * is the whole security model. This file walks the router's own route table, so a route added
 * later is covered automatically: each one must be invisible (404) without a session, to an
 * API key, and to a signed-in non-operator; refused (403) to an operator without 2FA; and
 * served (200, with an audit row) to an operator with 2FA.
 *
 * The JWT middleware is replaced by a header-driven stand-in — it is tested elsewhere; here we
 * only care about what sits behind it. Repositories and the service are mocked so nothing
 * touches a database.
 */
const ADMIN = '11111111-1111-4111-8111-111111111111';
const ADMIN_NO_2FA = '22222222-2222-4222-8222-222222222222';
const NON_ADMIN = '33333333-3333-4333-8333-333333333333';

const USERS: Record<string, { id: string; email: string; twoFactorEnabled: boolean }> = {
  [ADMIN]: { id: ADMIN, email: 'Root@Example.com', twoFactorEnabled: true },
  [ADMIN_NO_2FA]: { id: ADMIN_NO_2FA, email: 'ops@example.com', twoFactorEnabled: false },
  [NON_ADMIN]: { id: NON_ADMIN, email: 'user@example.com', twoFactorEnabled: true },
};

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  recordAdminAccess: vi.fn(),
  service: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: Context, next: Next) => {
    const userId = c.req.header('x-test-user');
    if (!userId) throw new HTTPException(401, { message: 'unauthenticated' });
    c.set('userId', userId);
    if (c.req.header('x-test-api-key')) c.set('isApiKeyAuth', true);
    await next();
  },
}));

vi.mock('../repositories/user.repository', () => ({
  userRepository: { findById: mocks.findById },
}));

vi.mock('../services/admin.service', () => ({
  // Every service method answers with an empty object — the test is about reaching it at all.
  adminService: new Proxy({}, { get: () => mocks.service }),
  recordAdminAccess: mocks.recordAdminAccess,
}));

vi.mock('../config/env', () => ({
  env: { ADMIN_EMAILS: 'root@example.com, ops@example.com', TRUSTED_PROXY_HOPS: 0 },
}));

vi.mock('../middleware/rate-limit', () => ({
  getClientIp: () => '127.0.0.1',
}));

import { adminRoutes } from './admin';

const endpoints = adminRoutes.routes
  .filter((r) => r.method !== 'ALL')
  .map((r) => ({ method: r.method, path: r.path.replace(':userId', ADMIN) }));

const call = (path: string, method: string, headers: Record<string, string> = {}) =>
  adminRoutes.request(path, { method, headers });

beforeEach(() => {
  mocks.findById.mockReset().mockImplementation(async (id: string) => USERS[id]);
  mocks.recordAdminAccess.mockReset();
  mocks.service.mockReset().mockResolvedValue({ ok: true });
});

describe('admin routes', () => {
  it('has a route table to walk', () => {
    expect(endpoints.length).toBeGreaterThanOrEqual(5);
  });

  it('answers 404 (not 403) to a non-operator so the panel is not confirmed to exist', async () => {
    const res = await call('/overview', 'GET', { 'x-test-user': NON_ADMIN });
    expect(res.status).toBe(404);
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.recordAdminAccess).not.toHaveBeenCalled();
  });

  it('matches the allowlist case-insensitively', async () => {
    // Root@Example.com in the database, root@example.com in ADMIN_EMAILS.
    const res = await call('/overview', 'GET', { 'x-test-user': ADMIN });
    expect(res.status).toBe(200);
  });

  it('rejects an unknown user id even if it is in the token', async () => {
    const res = await call('/overview', 'GET', { 'x-test-user': 'ghost' });
    expect(res.status).toBe(404);
  });
});

describe.each(endpoints)('$method $path', ({ method, path }) => {
  it('is invisible without a session', async () => {
    expect((await call(path, method)).status).toBe(401);
  });

  it('is invisible to an API key, even an operator’s', async () => {
    const res = await call(path, method, { 'x-test-user': ADMIN, 'x-test-api-key': '1' });
    expect(res.status).toBe(404);
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('is invisible to a signed-in non-operator', async () => {
    const res = await call(path, method, { 'x-test-user': NON_ADMIN });
    expect(res.status).toBe(404);
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it('refuses an operator without two-factor', async () => {
    const res = await call(path, method, { 'x-test-user': ADMIN_NO_2FA });
    expect(res.status).toBe(403);
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.recordAdminAccess).not.toHaveBeenCalled();
  });

  it('serves an operator with two-factor and records the access', async () => {
    const res = await call(path, method, { 'x-test-user': ADMIN, 'user-agent': 'vitest' });
    expect(res.status).toBe(200);
    expect(mocks.service).toHaveBeenCalledTimes(1);
    expect(mocks.recordAdminAccess).toHaveBeenCalledWith(
      expect.objectContaining({ adminUserId: ADMIN, method, path, userAgent: 'vitest' }),
    );
  });
});
