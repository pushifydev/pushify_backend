import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono, type Context } from 'hono';

/**
 * PUT /projects/:projectId/health-check: only the config fields are written, so a body carrying
 * projectId / id / createdAt cannot move the record to another (organization's) project, and
 * out-of-range or malformed values answer 400 before anything is stored.
 *
 * The real auth middleware, role check, route, service and repository run; the JWT check,
 * membership, the database and the plan limits are mocked.
 */
const { h } = vi.hoisted(() => ({
  h: {
    roles: {} as Record<string, string>,
    project: null as Record<string, unknown> | null,
    existing: null as Record<string, unknown> | null,
    updates: [] as Array<Record<string, unknown>>,
    inserts: [] as Array<Record<string, unknown>>,
  },
}));

const PROJECT_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_PROJECT_ID = '00000000-0000-4000-8000-0000000000f9';

vi.mock('../db', () => ({
  db: {
    // requireProjectMember: the project row, when it is the organization's
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (h.project && h.project.organizationId === 'org-1' ? [h.project] : []) }),
      }),
    }),
    query: { healthChecks: { findFirst: async () => h.existing ?? undefined } },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        h.updates.push(values);
        return { where: () => ({ returning: async () => [{ ...h.existing, ...values }] }) };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        h.inserts.push(values);
        return { returning: async () => [{ id: 'hc-new', ...values }] };
      },
    }),
  },
}));
vi.mock('../services/apikey.service', () => ({
  apiKeyService: { validate: vi.fn(async () => null) },
  hasScope: () => true,
}));
vi.mock('../lib/jwt', () => ({
  // `session-<role>` is a signed-in user with that role
  verifyToken: async (token: string) => ({ type: 'access', sub: `u-${token.replace('session-', '')}`, org: 'org-1' }),
}));
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
  applyPlanApiRateLimit: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: {
    findMember: async (_orgId: string, userId: string) => (h.roles[userId] ? { role: h.roles[userId], restrictedAccess: false } : null),
  },
}));
vi.mock('../repositories/project.repository', () => ({
  projectRepository: { findById: async () => h.project },
}));
vi.mock('../services/plan-limits.service', () => ({
  planLimitsService: { assertHealthChecksAllowed: vi.fn(async () => {}) },
}));
vi.mock('../services/notification.service', () => ({ notificationService: { sendNotifications: vi.fn() } }));
vi.mock('../lib/container-resolve', () => ({ restartPushifyContainer: vi.fn() }));

import { errorHandler } from '../middleware/error-handler';
import { healthCheckService } from '../services/healthcheck.service';
import { healthCheckRoutes } from './healthchecks';

const app = new Hono();
app.route('/api/v1/projects', healthCheckRoutes);
app.onError((err, c) => errorHandler(err, c as Context));

const put = (body: unknown, token = 'session-member') =>
  app.request(`/api/v1/projects/${PROJECT_ID}/health-check`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  h.roles = { 'u-member': 'member', 'u-viewer': 'viewer' };
  h.project = { id: PROJECT_ID, slug: 'shop', organizationId: 'org-1', serverId: null };
  h.existing = {
    id: 'hc-1',
    projectId: PROJECT_ID,
    endpoint: '/health',
    intervalSeconds: 30,
    timeoutSeconds: 10,
    unhealthyThreshold: 3,
    autoRestart: true,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
  h.updates = [];
  h.inserts = [];
});

describe('PUT /api/v1/projects/:projectId/health-check', () => {
  it('ignores projectId, id and createdAt in the body: the record stays on its project', async () => {
    const res = await put({
      projectId: OTHER_PROJECT_ID,
      id: '00000000-0000-4000-8000-0000000000ee',
      createdAt: '2020-01-01T00:00:00Z',
      endpoint: '/ready',
      unhealthyThreshold: 1,
      autoRestart: false,
    });

    expect(res.status).toBe(200);
    expect(h.updates).toHaveLength(1);
    const { updatedAt, ...written } = h.updates[0];
    expect(updatedAt).toBeInstanceOf(Date);
    expect(written).toEqual({ endpoint: '/ready', unhealthyThreshold: 1, autoRestart: false });
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.projectId).toBe(PROJECT_ID);
    expect(body.data.id).toBe('hc-1');
  });

  it('the service itself writes only config fields, whatever its caller passes', async () => {
    await healthCheckService.upsertConfig(
      PROJECT_ID,
      'org-1',
      'u-member',
      { projectId: OTHER_PROJECT_ID, id: 'x', createdAt: new Date(0), isActive: false } as never,
      'en'
    );

    expect(h.updates).toHaveLength(1);
    expect(Object.keys(h.updates[0]).sort()).toEqual(['isActive', 'updatedAt']);
  });

  it('creates a missing config for the route project only', async () => {
    h.existing = null;
    const res = await put({ projectId: OTHER_PROJECT_ID, id: 'x', endpoint: '/up', intervalSeconds: 60 });

    expect(res.status).toBe(200);
    expect(h.inserts).toEqual([
      {
        projectId: PROJECT_ID,
        endpoint: '/up',
        intervalSeconds: 60,
        timeoutSeconds: 10,
        unhealthyThreshold: 3,
        autoRestart: true,
        isActive: true,
      },
    ]);
  });

  it.each([
    ['an endpoint that is not a path', { endpoint: 'not a path' }],
    ['an endpoint over 500 characters', { endpoint: `/${'a'.repeat(500)}` }],
    ['an interval under 10 seconds', { intervalSeconds: 9 }],
    ['an interval over 3600 seconds', { intervalSeconds: 3601 }],
    ['a fractional interval', { intervalSeconds: 30.5 }],
    ['a timeout of 0', { timeoutSeconds: 0 }],
    ['a timeout over 60 seconds', { timeoutSeconds: 61 }],
    ['an unhealthy threshold of 0', { unhealthyThreshold: 0 }],
    ['an unhealthy threshold over 20', { unhealthyThreshold: 21 }],
    ['a string number', { intervalSeconds: '30' }],
    ['a non-boolean autoRestart', { autoRestart: 'yes' }],
    ['a non-boolean isActive', { isActive: 1 }],
  ])('answers 400 for %s and writes nothing', async (_label, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(h.updates).toHaveLength(0);
    expect(h.inserts).toHaveLength(0);
  });

  it('answers 400 for a body that is not JSON', async () => {
    const res = await put('not json');
    expect(res.status).toBe(400);
    expect(h.updates).toHaveLength(0);
  });

  it('accepts the bounds', async () => {
    const res = await put({
      endpoint: `/${'a'.repeat(499)}`,
      intervalSeconds: 10,
      timeoutSeconds: 60,
      unhealthyThreshold: 20,
      autoRestart: true,
      isActive: false,
    });
    expect(res.status).toBe(200);
    expect(h.updates).toHaveLength(1);
  });

  it('still refuses viewers', async () => {
    const res = await put({ endpoint: '/health' }, 'session-viewer');
    expect(res.status).toBe(403);
    expect(h.updates).toHaveLength(0);
  });
});
