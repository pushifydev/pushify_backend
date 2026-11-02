import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';

/**
 * POST /members, PATCH /members/:userId and POST /invitations may only grant admin, member or
 * viewer. 'owner' is valid in the DB enum, so without a check an admin could promote themselves
 * (or anyone) past every owner-only gate. The routes refuse it with 400, and so does the service.
 */

const mocks = vi.hoisted(() => ({
  findMember: vi.fn(),
  findById: vi.fn(),
  addMember: vi.fn(),
  updateMemberRole: vi.fn(),
  findPendingInvitationByEmail: vi.fn(),
  createInvitation: vi.fn(),
  findUserByEmail: vi.fn(),
  findUserById: vi.fn(),
  assertTeamMembersQuota: vi.fn(),
  sendOrgInvitationEmail: vi.fn(),
  logMemberAdded: vi.fn(),
  logMemberRoleChanged: vi.fn(),
}));

vi.mock('../middleware/auth', () => {
  const mw = async (c: Context, next: () => Promise<void>) => {
    c.set('userId', c.req.header('x-test-user') ?? 'user-admin');
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
  activityService: { logMemberAdded: mocks.logMemberAdded, logMemberRoleChanged: mocks.logMemberRoleChanged },
}));
vi.mock('../services/plan-limits.service', () => ({
  planLimitsService: { assertTeamMembersQuota: mocks.assertTeamMembersQuota },
}));
vi.mock('../lib/email', () => ({ sendOrgInvitationEmail: mocks.sendOrgInvitationEmail }));
vi.mock('../lib/org-two-factor', () => ({
  userHasTwoFactorEnabled: vi.fn(),
  invalidateOrgTwoFactorPolicy: vi.fn(),
}));
vi.mock('../repositories/user.repository', () => ({
  userRepository: { findByEmail: mocks.findUserByEmail, findById: mocks.findUserById },
}));
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: {
    findMember: mocks.findMember,
    findById: mocks.findById,
    addMember: mocks.addMember,
    updateMemberRole: mocks.updateMemberRole,
    findPendingInvitationByEmail: mocks.findPendingInvitationByEmail,
    createInvitation: mocks.createInvitation,
  },
}));

const { organizationRoutes } = await import('./organizations');
const { organizationService } = await import('../services/organization.service');
const { errorHandler } = await import('../middleware/error-handler');

const ROLES: Record<string, string> = {
  'user-owner': 'owner',
  'user-admin': 'admin',
  'user-member': 'member',
  'user-viewer': 'viewer',
};

function app() {
  const a = new Hono();
  a.onError(errorHandler);
  a.route('/api/v1/organizations', organizationRoutes);
  return a;
}

function send(method: string, path: string, body: unknown, user = 'user-admin') {
  return app().request(`/api/v1/organizations${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: JSON.stringify(body),
  });
}

const INVALID_ROLES: unknown[] = ['owner', 'OWNER', 'superuser', '', 42, null, ['admin'], { role: 'admin' }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMember.mockImplementation(async (_org: string, userId: string) =>
    ROLES[userId] ? { userId, role: ROLES[userId] } : null,
  );
  mocks.findById.mockResolvedValue({ id: 'org-1', name: 'Acme' });
  mocks.addMember.mockImplementation(async (data: { userId: string; role: string }) => ({ ...data }));
  mocks.updateMemberRole.mockImplementation(async (_org: string, userId: string, role: string) => ({ userId, role }));
  mocks.findPendingInvitationByEmail.mockResolvedValue(null);
  mocks.createInvitation.mockImplementation(async (data: { email: string; role: string }) => ({ id: 'inv-1', ...data }));
  mocks.findUserByEmail.mockImplementation(async (email: string) =>
    email === 'new@example.com' ? { id: 'user-new', email } : null,
  );
  mocks.findUserById.mockResolvedValue({ id: 'user-admin', name: 'Ada' });
  mocks.assertTeamMembersQuota.mockResolvedValue(undefined);
  mocks.sendOrgInvitationEmail.mockResolvedValue(undefined);
});

describe('PATCH /organizations/members/:userId', () => {
  it('refuses an admin making themselves owner', async () => {
    const res = await send('PATCH', '/members/user-admin', { role: 'owner' });

    expect(res.status).toBe(400);
    expect(mocks.updateMemberRole).not.toHaveBeenCalled();
    expect(mocks.logMemberRoleChanged).not.toHaveBeenCalled();
  });

  it('refuses making another member owner, for admins and owners alike', async () => {
    for (const user of ['user-admin', 'user-owner']) {
      const res = await send('PATCH', '/members/user-member', { role: 'owner' }, user);
      expect(res.status, user).toBe(400);
    }
    expect(mocks.updateMemberRole).not.toHaveBeenCalled();
  });

  it('answers 400, not 500, for anything that is not an assignable role', async () => {
    for (const role of INVALID_ROLES) {
      const res = await send('PATCH', '/members/user-member', { role });
      expect(res.status, JSON.stringify(role)).toBe(400);
    }
    const missing = await send('PATCH', '/members/user-member', {});
    expect(missing.status).toBe(400);
    expect(mocks.updateMemberRole).not.toHaveBeenCalled();
  });

  it.each(['admin', 'member', 'viewer'])('still assigns %s', async (role) => {
    const res = await send('PATCH', '/members/user-viewer', { role });

    expect(res.status).toBe(200);
    expect(mocks.updateMemberRole).toHaveBeenCalledWith('org-1', 'user-viewer', role);
    expect(mocks.logMemberRoleChanged.mock.calls[0].slice(0, 5)).toEqual([
      'org-1', 'user-admin', 'user-viewer', 'viewer', role,
    ]);
  });
});

describe('POST /organizations/members', () => {
  it('refuses adding an owner', async () => {
    const res = await send('POST', '/members', { email: 'new@example.com', role: 'owner' });

    expect(res.status).toBe(400);
    expect(mocks.addMember).not.toHaveBeenCalled();
    expect(mocks.logMemberAdded).not.toHaveBeenCalled();
  });

  it('answers 400 for an invalid role', async () => {
    for (const role of INVALID_ROLES.filter((r) => r)) {
      const res = await send('POST', '/members', { email: 'new@example.com', role });
      expect(res.status, JSON.stringify(role)).toBe(400);
    }
    expect(mocks.addMember).not.toHaveBeenCalled();
  });

  it.each(['admin', 'member', 'viewer'])('still adds a %s', async (role) => {
    const res = await send('POST', '/members', { email: 'new@example.com', role });

    expect(res.status).toBe(201);
    expect(mocks.addMember).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-new', role }));
  });

  it('defaults to member when no role is given', async () => {
    const res = await send('POST', '/members', { email: 'new@example.com' });

    expect(res.status).toBe(201);
    expect(mocks.addMember).toHaveBeenCalledWith(expect.objectContaining({ role: 'member' }));
  });
});

describe('POST /organizations/invitations', () => {
  it('refuses inviting an owner', async () => {
    const res = await send('POST', '/invitations', { email: 'someone@example.com', role: 'owner' });

    expect(res.status).toBe(400);
    expect(mocks.createInvitation).not.toHaveBeenCalled();
    expect(mocks.sendOrgInvitationEmail).not.toHaveBeenCalled();
  });

  it('answers 400 for an invalid role', async () => {
    for (const role of INVALID_ROLES.filter((r) => r)) {
      const res = await send('POST', '/invitations', { email: 'someone@example.com', role });
      expect(res.status, JSON.stringify(role)).toBe(400);
    }
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });

  it.each(['admin', 'member', 'viewer'])('still invites a %s', async (role) => {
    const res = await send('POST', '/invitations', { email: 'someone@example.com', role });

    expect(res.status).toBe(201);
    expect(mocks.createInvitation).toHaveBeenCalledWith(expect.objectContaining({ email: 'someone@example.com', role }));
  });

  it('defaults to member when no role is given', async () => {
    const res = await send('POST', '/invitations', { email: 'someone@example.com' });

    expect(res.status).toBe(201);
    expect(mocks.createInvitation).toHaveBeenCalledWith(expect.objectContaining({ role: 'member' }));
  });
});

describe('organizationService: owner is refused even past the route', () => {
  const owner = 'owner' as unknown as 'admin';

  it('updateMemberRole', async () => {
    await expect(
      organizationService.updateMemberRole('org-1', 'user-admin', 'user-admin', owner),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.updateMemberRole).not.toHaveBeenCalled();
  });

  it('addMember', async () => {
    await expect(
      organizationService.addMember('org-1', 'user-admin', 'new@example.com', owner),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.addMember).not.toHaveBeenCalled();
  });

  it('sendInvitation', async () => {
    await expect(
      organizationService.sendInvitation('org-1', 'user-admin', 'someone@example.com', owner, undefined),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });
});
