import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';

/**
 * PUT /api/v1/organizations/two-factor-policy: owner only, turning it on needs the owner's own
 * 2FA (400 otherwise), every real change is written to the audit log, and the general
 * PATCH /organizations cannot set the column on the side.
 */

const mocks = vi.hoisted(() => ({
  findMember: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  findBySlug: vi.fn(),
  hasTwoFactor: vi.fn(),
  invalidate: vi.fn(),
  logTwoFactorPolicyChanged: vi.fn(),
}));

vi.mock('../middleware/auth', () => {
  const mw = async (c: Context, next: () => Promise<void>) => {
    c.set('userId', c.req.header('x-test-user') ?? 'user-owner');
    c.set('organizationId', 'org-1');
    c.set('locale', 'en');
    await next();
  };
  return { authMiddleware: mw, combinedAuthMiddleware: mw };
});
vi.mock('../middleware/apikey-auth', () => ({
  rejectApiKeyAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../db', () => ({ db: {} }));
vi.mock('../services/auth.service', () => ({ authService: {} }));
vi.mock('../services/activity.service', () => ({
  activityService: { logTwoFactorPolicyChanged: mocks.logTwoFactorPolicyChanged },
}));
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: {
    findMember: mocks.findMember,
    findById: mocks.findById,
    update: mocks.update,
    findBySlug: mocks.findBySlug,
  },
}));
vi.mock('../lib/org-two-factor', () => ({
  userHasTwoFactorEnabled: mocks.hasTwoFactor,
  invalidateOrgTwoFactorPolicy: mocks.invalidate,
}));

const { organizationRoutes } = await import('./organizations');
const { errorHandler } = await import('../middleware/error-handler');

const ROLES: Record<string, string> = { 'user-owner': 'owner', 'user-admin': 'admin', 'user-member': 'member' };
let current = { requireTwoFactor: false };

function app() {
  const a = new Hono();
  a.onError(errorHandler);
  a.route('/api/v1/organizations', organizationRoutes);
  return a;
}

function put(body: unknown, user = 'user-owner') {
  return app().request('/api/v1/organizations/two-factor-policy', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  current = { requireTwoFactor: false };
  mocks.findMember.mockImplementation(async (_org: string, userId: string) =>
    ROLES[userId] ? { userId, role: ROLES[userId] } : null,
  );
  mocks.findById.mockImplementation(async () => ({ id: 'org-1', ...current }));
  mocks.update.mockImplementation(async (_id: string, data: Record<string, unknown>) => {
    current = { ...current, ...data };
    return { id: 'org-1', ...current };
  });
  mocks.findBySlug.mockResolvedValue(null);
  mocks.hasTwoFactor.mockResolvedValue(true);
});

describe('PUT /organizations/two-factor-policy', () => {
  it('lets an owner with 2FA turn it on, and audits it', async () => {
    const res = await put({ requireTwoFactor: true });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ requireTwoFactor: true });
    expect(mocks.update).toHaveBeenCalledWith('org-1', { requireTwoFactor: true });
    expect(mocks.invalidate).toHaveBeenCalledWith('org-1');
    expect(mocks.logTwoFactorPolicyChanged).toHaveBeenCalledTimes(1);
    expect(mocks.logTwoFactorPolicyChanged.mock.calls[0].slice(0, 3)).toEqual(['org-1', 'user-owner', true]);
  });

  it('turning it off is audited too, and needs no 2FA of the owner', async () => {
    current = { requireTwoFactor: true };
    mocks.hasTwoFactor.mockResolvedValue(false);

    const res = await put({ requireTwoFactor: false });

    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('org-1', { requireTwoFactor: false });
    expect(mocks.logTwoFactorPolicyChanged.mock.calls[0].slice(0, 3)).toEqual(['org-1', 'user-owner', false]);
  });

  it('answers 400 when the owner has no 2FA of their own', async () => {
    mocks.hasTwoFactor.mockResolvedValue(false);

    const res = await put({ requireTwoFactor: true });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('TWO_FACTOR_NOT_ENABLED');
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.logTwoFactorPolicyChanged).not.toHaveBeenCalled();
  });

  it('is owner only: admins and members get 403', async () => {
    for (const user of ['user-admin', 'user-member']) {
      const res = await put({ requireTwoFactor: true }, user);
      expect(res.status, user).toBe(403);
    }
    const outsider = await put({ requireTwoFactor: true }, 'user-stranger');
    expect(outsider.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.logTwoFactorPolicyChanged).not.toHaveBeenCalled();
  });

  it('writes no audit entry when nothing changes', async () => {
    current = { requireTwoFactor: true };

    const res = await put({ requireTwoFactor: true });

    expect(res.status).toBe(200);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.logTwoFactorPolicyChanged).not.toHaveBeenCalled();
  });

  it('refuses a body without a boolean', async () => {
    for (const body of [{}, { requireTwoFactor: 'yes' }, { required: true }]) {
      const res = await put(body);
      expect(res.status).toBe(400);
    }
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe('PATCH /organizations', () => {
  it('only writes name and slug, never the 2FA requirement', async () => {
    const res = await app().request('/api/v1/organizations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-test-user': 'user-admin' },
      body: JSON.stringify({ name: 'Acme', requireTwoFactor: true, plan: 'enterprise' }),
    });

    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('org-1', { name: 'Acme' });
  });
});
