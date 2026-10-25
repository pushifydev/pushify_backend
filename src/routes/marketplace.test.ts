import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono, type Context } from 'hono';

/**
 * A marketplace app's env vars (generated passwords, Supabase JWT_SECRET / SERVICE_ROLE_KEY) are
 * stored encrypted as env vars. GET /marketplace/deployments is a viewer read, so it must carry
 * only their names: not for a viewer, not for a key without projects:read, not for rows written
 * before the values were dropped from marketplace_deployments.configuration.
 *
 * POST /marketplace/deploy creates a project and starts a deploy, so it needs projects:write and
 * the same plan quotas (projects, deployments, build minutes) as the normal project/deploy path.
 *
 * The real authMiddleware, route and service run; key validation, the JWT check, membership, the
 * plan quotas and the database are mocked.
 */
const { h } = vi.hoisted(() => ({
  h: {
    validate: vi.fn(),
    verifyToken: vi.fn(),
    requireOrgMember: vi.fn(),
    allowedProjectIds: vi.fn(),
    assertProjectsQuota: vi.fn(),
    assertDeploymentsQuota: vi.fn(),
    assertBuildMinutesQuota: vi.fn(),
    rows: [] as unknown[],
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
vi.mock('../lib/member-project-scope', () => ({ getMemberAllowedProjectIds: h.allowedProjectIds }));
vi.mock('../services/organization-billing.service', () => ({ assertOrganizationCanMutateResources: async () => {} }));
vi.mock('../lib/deployment-scheduler', () => ({ scheduleDeploymentProcessing: async () => {} }));
vi.mock('../services/plan-limits.service', () => ({
  planLimitsService: {
    assertProjectsQuota: h.assertProjectsQuota,
    assertDeploymentsQuota: h.assertDeploymentsQuota,
    assertBuildMinutesQuota: h.assertBuildMinutesQuota,
  },
}));
vi.mock('../db', () => {
  const select = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where']) c[m] = () => c;
    c.orderBy = async () => h.rows;
    return c;
  };
  const insert = (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      h.inserts.push({ table, values });
      return { returning: async () => [{ id: `row-${h.inserts.length}`, createdAt: new Date(0), ...values }] };
    },
  });
  return {
    db: {
      select: vi.fn(select),
      insert: vi.fn(insert),
      query: { servers: { findFirst: async () => ({ id: 'server-1', organizationId: 'org-1' }) } },
    },
  };
});

import { HTTPException } from 'hono/http-exception';
import { errorHandler } from '../middleware/error-handler';
import { t } from '../i18n';
import { db } from '../db';
import { environmentVariables, marketplaceDeployments } from '../db/schema';
import { decrypt } from '../lib/encryption';
import { configurationKeys } from '../services/marketplace.service';
import { marketplaceRoutes } from './marketplace';

const app = new Hono();
app.route('/api/v1/marketplace', marketplaceRoutes);
app.onError((err, c) => errorHandler(err, c as Context));

const SECRETS = {
  JWT_SECRET: 'jwt-secret-plain-text-value-0123456789',
  SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.service-role.signature',
  POSTGRES_PASSWORD: 'pg-password-plain-text',
};

const KEYS: Record<string, string> = {
  pk_live_metrics_only: 'metrics:read',
  pk_live_projects_read: 'projects:read',
  pk_live_projects_write: 'projects:write',
};

const get = (token: string) =>
  app.request('/api/v1/marketplace/deployments', { headers: { Authorization: `Bearer ${token}` } });

const deploy = (token: string) =>
  app.request('/api/v1/marketplace/deploy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ templateId: 'redis', serverId: 'server-1', name: 'cache' }),
  });

function expectNoSecret(body: unknown) {
  const json = JSON.stringify(body);
  for (const value of Object.values(SECRETS)) expect(json).not.toContain(value);
}

beforeEach(() => {
  vi.mocked(db.select).mockClear();
  h.inserts = [];
  h.validate.mockReset().mockImplementation(async (token: string) =>
    KEYS[token]
      ? { userId: 'user-1', organizationId: 'org-1', apiKey: { id: 'key-1', name: 'k', scopes: KEYS[token] } }
      : null
  );
  h.verifyToken.mockReset().mockResolvedValue({ type: 'access', sub: 'user-1', org: 'org-1' });
  h.requireOrgMember.mockReset().mockResolvedValue({ role: 'viewer', restrictedAccess: false });
  h.allowedProjectIds.mockReset().mockResolvedValue(null);
  h.assertProjectsQuota.mockReset().mockResolvedValue(undefined);
  h.assertDeploymentsQuota.mockReset().mockResolvedValue(undefined);
  h.assertBuildMinutesQuota.mockReset().mockResolvedValue(undefined);
  h.rows = [
    {
      // Written before migration 0080: every value in plain text
      marketplace_deployments: { id: 'mp-1', projectId: 'p-1', templateId: 'supabase', configuration: SECRETS },
      projects: { id: 'p-1', organizationId: 'org-1', name: 'supabase', webhookSecret: 'whsec' },
    },
    {
      marketplace_deployments: { id: 'mp-2', projectId: 'p-2', templateId: 'redis', configuration: ['REDIS_PASSWORD'] },
      projects: { id: 'p-2', organizationId: 'org-1', name: 'redis', webhookSecret: 'whsec' },
    },
  ];
});

describe('GET /marketplace/deployments', () => {
  it('shows a viewer the env var names, never the values', async () => {
    const res = await get('session-access-token');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configuration: unknown; project: Record<string, unknown> }[];
    expect(body.map((d) => d.configuration)).toEqual([Object.keys(SECRETS), ['REDIS_PASSWORD']]);
    expect(body[0].project.webhookSecret).toBeUndefined();
    expectNoSecret(body);
  });

  it('refuses an API key without projects:read before reading anything', async () => {
    const res = await get('pk_live_metrics_only');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      t('en', 'apiKeys', 'insufficientScope')
    );
    expect(h.requireOrgMember).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('gives a projects:read key the names only', async () => {
    const res = await get('pk_live_projects_read');
    expect(res.status).toBe(200);
    expectNoSecret(await res.json());
  });

  it('lists nothing for a restricted member with no projects', async () => {
    h.requireOrgMember.mockResolvedValue({ role: 'member', restrictedAccess: true });
    h.allowedProjectIds.mockResolvedValue([]);
    const res = await get('session-access-token');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('POST /marketplace/deploy', () => {
  beforeEach(() => {
    h.requireOrgMember.mockResolvedValue({ role: 'member', restrictedAccess: false });
  });

  it('keeps generated values in encrypted env vars only', async () => {
    const res = await deploy('session-access-token');
    expect(res.status).toBe(201);

    const envVars = h.inserts.find((i) => i.table === environmentVariables)!.values as { key: string; valueEncrypted: string }[];
    expect(envVars.map((v) => v.key)).toEqual(['REDIS_PASSWORD']);
    const password = decrypt(envVars[0].valueEncrypted);
    expect(password.length).toBeGreaterThan(0);

    const record = h.inserts.find((i) => i.table === marketplaceDeployments)!.values as { configuration: unknown };
    expect(record.configuration).toEqual(['REDIS_PASSWORD']);

    const body = (await res.json()) as { marketplaceDeployment: { configuration: unknown } };
    expect(body.marketplaceDeployment.configuration).toEqual(['REDIS_PASSWORD']);
    expect(JSON.stringify(body)).not.toContain(password);
  });

  it('refuses an API key without projects:write before creating anything', async () => {
    const res = await deploy('pk_live_metrics_only');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      t('en', 'apiKeys', 'insufficientScope')
    );
    expect(h.requireOrgMember).not.toHaveBeenCalled();
    expect(h.assertProjectsQuota).not.toHaveBeenCalled();
    expect(h.inserts).toEqual([]);
  });

  it('refuses a projects:read key too', async () => {
    const res = await deploy('pk_live_projects_read');
    expect(res.status).toBe(403);
    expect(h.inserts).toEqual([]);
  });

  it('lets a projects:write key deploy within the plan quotas', async () => {
    const res = await deploy('pk_live_projects_write');
    expect(res.status).toBe(201);
    expect(h.assertProjectsQuota).toHaveBeenCalledWith('org-1', 'en');
    expect(h.assertDeploymentsQuota).toHaveBeenCalledWith('org-1', 'en');
    expect(h.assertBuildMinutesQuota).toHaveBeenCalledWith('org-1', 'en');
  });

  it.each([
    ['projects', h.assertProjectsQuota],
    ['deploymentsPerMonth', h.assertDeploymentsQuota],
    ['buildMinutesPerMonth', h.assertBuildMinutesQuota],
  ] as const)('answers 403 when the %s quota is full and creates nothing', async (limitKey, assertQuota) => {
    const message = t('en', 'planLimits', limitKey);
    assertQuota.mockRejectedValue(new HTTPException(403, { message }));

    const res = await deploy('session-access-token');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(message);
    expect(h.inserts).toEqual([]);
  });
});

describe('configurationKeys', () => {
  it('reads key names from both the old object and the new array shape', () => {
    expect(configurationKeys(SECRETS)).toEqual(Object.keys(SECRETS));
    expect(configurationKeys(['A', 1, 'B'])).toEqual(['A', 'B']);
    expect(configurationKeys(null)).toEqual([]);
    expect(configurationKeys('A=1')).toEqual([]);
  });
});
