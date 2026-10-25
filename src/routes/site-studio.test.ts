import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * POST /site-studio/launch creates a project and a deployment on both paths (static sites directly,
 * CMS sites through marketplaceService.deploy). It must need projects:write on an API key and run
 * the same plan quotas (projects, deployments, build minutes) as the normal project/deploy path.
 *
 * The real authMiddleware, route and services run; key validation, the JWT check, membership, the
 * plan quotas, the site editor, domains and the database are mocked.
 */
const { h } = vi.hoisted(() => ({
  h: {
    validate: vi.fn(),
    verifyToken: vi.fn(),
    requireOrgMember: vi.fn(),
    assertProjectsQuota: vi.fn(),
    assertDeploymentsQuota: vi.fn(),
    assertBuildMinutesQuota: vi.fn(),
    schedule: vi.fn(),
    inserts: [] as { table: unknown; values: unknown }[],
  },
}));

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
  applyPlanApiRateLimit: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../lib/org-access', () => ({ requireOrgMember: h.requireOrgMember }));
vi.mock('../services/organization-billing.service', () => ({ assertOrganizationCanMutateResources: async () => {} }));
vi.mock('../lib/deployment-scheduler', () => ({ scheduleDeploymentProcessing: h.schedule }));
vi.mock('../services/plan-limits.service', () => ({
  planLimitsService: {
    assertProjectsQuota: h.assertProjectsQuota,
    assertDeploymentsQuota: h.assertDeploymentsQuota,
    assertBuildMinutesQuota: h.assertBuildMinutesQuota,
  },
}));
vi.mock('../services/site-editor.service', () => ({ siteEditorService: { initializeForProject: async () => {} } }));
vi.mock('../services/domain.service', () => ({ domainService: { create: async () => null } }));
vi.mock('../repositories/project.repository', () => ({ projectRepository: { slugExists: async () => false } }));
vi.mock('../db', () => {
  const insert = (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      h.inserts.push({ table, values });
      return { returning: async () => [{ id: `row-${h.inserts.length}`, createdAt: new Date(0), ...values }] };
    },
  });
  const update = () => ({ set: () => ({ where: async () => undefined }) });
  return {
    db: {
      insert: vi.fn(insert),
      update: vi.fn(update),
      query: {
        servers: {
          findFirst: async () => ({ id: 'server-1', organizationId: 'org-1', ipv4: '203.0.113.10', sshPrivateKey: 'enc' }),
        },
      },
    },
  };
});

import { errorHandler } from '../middleware/error-handler';
import { t } from '../i18n';
import { deployments, projects } from '../db/schema';
import { siteStudioRoutes } from './site-studio';

const app = new Hono();
app.route('/api/v1/site-studio', siteStudioRoutes);
app.onError((err, c) => errorHandler(err, c as Context));

const KEYS: Record<string, string> = {
  pk_live_metrics_only: 'metrics:read',
  pk_live_projects_read: 'projects:read',
  pk_live_projects_write: 'projects:write',
};

// 'static-business' is served from Nginx (launchStatic); 'ecommerce-store' is WordPress (marketplace deploy).
const STATIC = 'static-business';
const CMS = 'ecommerce-store';

const launch = (token: string, siteTemplateId = STATIC) =>
  app.request('/api/v1/site-studio/launch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ siteTemplateId, serverId: 'server-1', name: 'My Site' }),
  });

const errorMessage = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;

beforeEach(() => {
  h.inserts = [];
  h.validate.mockReset().mockImplementation(async (token: string) =>
    KEYS[token]
      ? { userId: 'user-1', organizationId: 'org-1', apiKey: { id: 'key-1', name: 'k', scopes: KEYS[token] } }
      : null
  );
  h.verifyToken.mockReset().mockResolvedValue({ type: 'access', sub: 'user-1', org: 'org-1' });
  h.requireOrgMember.mockReset().mockResolvedValue({ role: 'member', restrictedAccess: false });
  h.assertProjectsQuota.mockReset().mockResolvedValue(undefined);
  h.assertDeploymentsQuota.mockReset().mockResolvedValue(undefined);
  h.assertBuildMinutesQuota.mockReset().mockResolvedValue(undefined);
  h.schedule.mockReset().mockResolvedValue(undefined);
});

describe('POST /site-studio/launch: API key scope', () => {
  it('refuses a key without projects:write before creating anything', async () => {
    const res = await launch('pk_live_metrics_only');
    expect(res.status).toBe(403);
    expect(await errorMessage(res)).toBe(t('en', 'apiKeys', 'insufficientScope'));
    expect(h.requireOrgMember).not.toHaveBeenCalled();
    expect(h.assertProjectsQuota).not.toHaveBeenCalled();
    expect(h.inserts).toEqual([]);
  });

  it('refuses a projects:read key too', async () => {
    const res = await launch('pk_live_projects_read');
    expect(res.status).toBe(403);
    expect(h.inserts).toEqual([]);
  });

  it('lets a projects:write key launch a static site within the plan quotas', async () => {
    const res = await launch('pk_live_projects_write');
    expect(res.status).toBe(201);
    expect(h.assertProjectsQuota).toHaveBeenCalledWith('org-1', 'en');
    expect(h.assertDeploymentsQuota).toHaveBeenCalledWith('org-1', 'en');
    expect(h.assertBuildMinutesQuota).toHaveBeenCalledWith('org-1', 'en');
    expect(h.inserts.map((i) => i.table)).toEqual([projects, deployments]);
    expect(h.schedule).toHaveBeenCalledTimes(1);
  });
});

describe('POST /site-studio/launch: plan quotas', () => {
  const cases = [
    ['projects', h.assertProjectsQuota],
    ['deploymentsPerMonth', h.assertDeploymentsQuota],
    ['buildMinutesPerMonth', h.assertBuildMinutesQuota],
  ] as const;

  for (const [path, templateId] of [['static', STATIC], ['CMS', CMS]] as const) {
    it.each(cases)(`answers 403 on the ${path} path when the %s quota is full and creates nothing`, async (limitKey, assertQuota) => {
      const message = t('en', 'planLimits', limitKey);
      assertQuota.mockRejectedValue(new HTTPException(403, { message }));

      const res = await launch('session-access-token', templateId);
      expect(res.status).toBe(403);
      expect(await errorMessage(res)).toBe(message);
      expect(h.inserts).toEqual([]);
      expect(h.schedule).not.toHaveBeenCalled();
    });
  }

  it('still answers 400 LAUNCH_FAILED for an ordinary launch error', async () => {
    const res = await launch('session-access-token', 'no-such-template');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('LAUNCH_FAILED');
  });
});
