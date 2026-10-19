import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

/**
 * Team audit log: every critical action below must leave an entry in the organization's activity
 * log, entries are scoped to the caller's organization, the list is admin/owner only, and no
 * environment variable value ever reaches a log entry.
 */

const SECRET = 'sk_live_SUPER_SECRET_VALUE_123';

// ---- auth: the caller's org, user and role come from test headers ----
const ROLE_RANK: Record<string, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
vi.mock('../middleware/auth', () => {
  const mw = async (c: Context, next: () => Promise<void>) => {
    c.set('userId', c.req.header('x-test-user') ?? 'user-1');
    c.set('organizationId', c.req.header('x-test-org') ?? 'org-A');
    c.set('locale', 'en');
    if (c.req.header('x-test-apikey')) c.set('isApiKeyAuth', true);
    await next();
  };
  return { combinedAuthMiddleware: mw, authMiddleware: mw };
});
vi.mock('../middleware/apikey-auth', () => ({
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  rejectApiKeyAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../lib/org-access', () => ({
  requireMinRole: (min: string) => async (c: Context, next: () => Promise<void>) => {
    const role = c.req.header('x-test-role') ?? 'owner';
    if (ROLE_RANK[role] < ROLE_RANK[min]) return c.json({ message: 'Forbidden' }, 403);
    await next();
  },
}));
vi.mock('../middleware/rate-limit', () => ({
  createDeploymentRateLimiter: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../db', () => ({ db: {} }));

// ---- services ----
const logged: Array<{ method: string; args: unknown[] }> = [];
const record = (method: string) => vi.fn(async (...args: unknown[]) => { logged.push({ method, args }); });
const getByOrganization = vi.fn(async (_orgId: string, _f: unknown) => ({ logs: [], total: 0 }));
vi.mock('../services/activity.service', () => ({
  activityService: {
    log: record('log'),
    logDeploymentCreated: record('logDeploymentCreated'),
    logEnvVarCreated: record('logEnvVarCreated'),
    logEnvVarUpdated: record('logEnvVarUpdated'),
    logEnvVarDeleted: record('logEnvVarDeleted'),
    logDomainAdded: record('logDomainAdded'),
    logDomainRemoved: record('logDomainRemoved'),
    logMemberAdded: record('logMemberAdded'),
    logMemberRoleChanged: record('logMemberRoleChanged'),
    logMemberRemoved: record('logMemberRemoved'),
    getByOrganization,
  },
}));

const envVar = {
  id: 'ev-1', projectId: 'p-1', environment: 'production', key: 'STRIPE_KEY', value: 'sk_l********',
  isSecret: true, createdAt: new Date(), updatedAt: new Date(),
};
vi.mock('../services/envvar.service', () => ({
  envVarService: {
    create: vi.fn(async () => envVar),
    update: vi.fn(async () => envVar),
    getById: vi.fn(async () => envVar),
    delete: vi.fn(async () => undefined),
    bulkCreate: vi.fn(async () => [
      { id: 'ev-1', key: 'STRIPE_KEY', environment: 'production', isSecret: true, action: 'updated' },
      { id: 'ev-2', key: 'NEW_KEY', environment: 'production', isSecret: false, action: 'created' },
      { id: 'ev-3', key: 'SAME_KEY', environment: 'production', isSecret: true, action: 'unchanged' },
    ]),
  },
}));
const deployment = { id: 'dep-new', projectId: 'p-1', status: 'pending', createdAt: new Date() };
vi.mock('../services/deployment.service', () => ({
  deploymentService: {
    create: vi.fn(async () => deployment),
    rollback: vi.fn(async () => deployment),
  },
}));
vi.mock('../services/domain.service', () => ({
  domainService: {
    create: vi.fn(async () => ({ id: 'd-1', projectId: 'p-1', domain: 'app.example.com', isPrimary: false, sslStatus: null, verifiedAt: null, createdAt: new Date(), dns: {} })),
    getById: vi.fn(async () => ({ id: 'd-1', domain: 'app.example.com' })),
    delete: vi.fn(async () => undefined),
    getByProject: vi.fn(async () => [
      { id: 'd-0', domain: 'old.example.com', isPrimary: true },
      { id: 'd-1', domain: 'app.example.com', isPrimary: false },
    ]),
    setPrimary: vi.fn(async () => ({
      id: 'd-1', projectId: 'p-1', domain: 'app.example.com', isPrimary: true, sslStatus: null,
      verifiedAt: null, createdAt: new Date(), updatedAt: new Date(),
    })),
    getNginxSettings: vi.fn(async () => ({ forceHttps: false, clientMaxBodySize: '10m' })),
    updateNginxSettings: vi.fn(async () => ({
      forceHttps: true,
      clientMaxBodySize: '10m',
      customHeaders: { Authorization: 'Bearer HEADER_SECRET_XYZ', 'X-Team': 'web' },
    })),
  },
}));
vi.mock('../services/organization.service', () => ({
  organizationService: {
    addMember: vi.fn(async () => ({ userId: 'user-2', role: 'member' })),
    updateMemberRole: vi.fn(async () => ({ userId: 'user-2', role: 'admin' })),
    removeMember: vi.fn(async () => undefined),
  },
}));
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: { findMember: vi.fn(async () => ({ userId: 'user-2', role: 'member' })) },
}));

const { envVarRoutes } = await import('./envvars');
const { deploymentRoutes } = await import('./deployments');
const { domainRoutes } = await import('./domains');
const { organizationRoutes } = await import('./organizations');
const { activityRoutes } = await import('./activity');

const P = '00000000-0000-4000-8000-000000000001';
const ID = '00000000-0000-4000-8000-000000000002';
const json = (method: string, body?: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { 'content-type': 'application/json', ...headers },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

/** Mounted under their real prefixes so path params resolve as in production */
const { OpenAPIHono } = await import('@hono/zod-openapi');
const app = new OpenAPIHono();
app.route('/projects/:projectId/env', envVarRoutes);
app.route('/projects/:projectId/deployments', deploymentRoutes);
app.route('/projects/:projectId/domains', domainRoutes);
app.route('/organization', organizationRoutes);
app.route('/activity', activityRoutes);

const only = (method: string) => logged.filter((l) => l.method === method);

beforeEach(() => {
  logged.length = 0;
  getByOrganization.mockClear();
});

describe('audit log: critical events are recorded', () => {
  it('deploy start', async () => {
    const res = await app.request(`/projects/${P}/deployments`, json('POST', { branch: 'main' }));
    expect(res.status).toBe(201);
    expect(only('logDeploymentCreated')[0].args.slice(0, 4)).toEqual(['org-A', 'user-1', P, 'dep-new']);
  });

  it('deploy rollback', async () => {
    const res = await app.request(`/projects/${P}/deployments/${ID}/rollback`, json('POST'));
    expect(res.status).toBe(201);
    const entry = only('log')[0].args[0] as Record<string, unknown>;
    expect(entry).toMatchObject({ organizationId: 'org-A', userId: 'user-1', action: 'deployment.rolledback' });
  });

  it('env var added: key only', async () => {
    const res = await app.request(`/projects/${P}/env`, json('POST', { key: 'STRIPE_KEY', value: SECRET, isSecret: true }));
    expect(res.status).toBe(201);
    expect(only('logEnvVarCreated')[0].args.slice(0, 4)).toEqual(['org-A', 'user-1', P, 'STRIPE_KEY']);
  });

  it('env var changed: key and which fields changed, never the value', async () => {
    const res = await app.request(`/projects/${P}/env/${ID}`, json('PATCH', { value: SECRET }));
    expect(res.status).toBe(200);
    const args = only('logEnvVarUpdated')[0].args;
    expect(args.slice(0, 5)).toEqual([
      'org-A', 'user-1', P, 'STRIPE_KEY', { valueChanged: true, isSecret: { from: true, to: true } },
    ]);
    expect(args[7]).toBe('ui');
  });

  it('source is api when the caller used an API key', async () => {
    const res = await app.request(`/projects/${P}/env/${ID}`, json('PATCH', { value: SECRET }, { 'x-test-apikey': '1' }));
    expect(res.status).toBe(200);
    expect(only('logEnvVarUpdated')[0].args[7]).toBe('api');
  });

  it('primary domain change records from -> to', async () => {
    const res = await app.request(`/projects/${P}/domains/${ID}/primary`, json('POST'));
    expect(res.status).toBe(200);
    expect(only('log')[0].args[0]).toMatchObject({
      action: 'domain.set_primary',
      source: 'ui',
      changes: { primaryDomain: { from: 'old.example.com', to: 'app.example.com' } },
    });
  });

  it('nginx settings change records a redacted diff of the touched fields', async () => {
    const res = await app.request(
      `/projects/${P}/domains/${ID}/nginx-settings`,
      json('PATCH', { forceHttps: true, customHeaders: { Authorization: 'Bearer HEADER_SECRET_XYZ', 'X-Team': 'web' } })
    );
    expect(res.status).toBe(200);
    const entry = only('log')[0].args[0] as Record<string, unknown>;
    expect(entry).toMatchObject({
      action: 'domain.nginx_updated',
      source: 'ui',
      changes: { forceHttps: { from: false, to: true } },
    });
    expect(Object.keys(entry.changes as object).sort()).toEqual(['customHeaders', 'forceHttps']);
    expect(entry.changes).not.toHaveProperty('clientMaxBodySize');
    expect((entry.changes as Record<string, { to: unknown }>).customHeaders.to).toEqual({
      Authorization: '[redacted]', 'X-Team': 'web',
    });
    expect(JSON.stringify(entry)).not.toContain('HEADER_SECRET_XYZ');
  });

  it('env var bulk upsert: one entry per created/updated key, unchanged keys skipped', async () => {
    const res = await app.request(
      `/projects/${P}/env/bulk`,
      json('POST', { variables: [{ key: 'STRIPE_KEY', value: SECRET }, { key: 'NEW_KEY', value: SECRET }, { key: 'SAME_KEY', value: 'x' }] })
    );
    expect(res.status).toBe(200);
    expect(only('logEnvVarUpdated').map((l) => l.args[3])).toEqual(['STRIPE_KEY']);
    expect(only('logEnvVarCreated').map((l) => l.args[3])).toEqual(['NEW_KEY']);
  });

  it('env var deleted', async () => {
    const res = await app.request(`/projects/${P}/env/${ID}`, json('DELETE'));
    expect(res.status).toBe(200);
    expect(only('logEnvVarDeleted')[0].args.slice(0, 4)).toEqual(['org-A', 'user-1', P, 'STRIPE_KEY']);
  });

  it('member added', async () => {
    const res = await app.request('/organization/members', json('POST', { email: 'new@example.com', role: 'member' }));
    expect(res.status).toBe(201);
    expect(only('logMemberAdded')[0].args.slice(0, 5)).toEqual(['org-A', 'user-1', 'user-2', 'new@example.com', 'member']);
  });

  it('member role changed: from -> to', async () => {
    const res = await app.request('/organization/members/user-2', json('PATCH', { role: 'admin' }));
    expect(res.status).toBe(200);
    expect(only('logMemberRoleChanged')[0].args.slice(0, 5)).toEqual(['org-A', 'user-1', 'user-2', 'member', 'admin']);
  });

  it('member removed', async () => {
    const res = await app.request('/organization/members/user-2', json('DELETE'));
    expect(res.status).toBe(200);
    expect(only('logMemberRemoved')[0].args.slice(0, 4)).toEqual(['org-A', 'user-1', 'user-2', 'member']);
  });

  it('domain added', async () => {
    const res = await app.request(`/projects/${P}/domains`, json('POST', { domain: 'app.example.com' }));
    expect(res.status).toBe(201);
    expect(only('logDomainAdded')[0].args.slice(0, 4)).toEqual(['org-A', 'user-1', P, 'app.example.com']);
  });

  it('domain removed', async () => {
    const res = await app.request(`/projects/${P}/domains/${ID}`, json('DELETE'));
    expect(res.status).toBe(200);
    expect(only('logDomainRemoved')[0].args.slice(0, 4)).toEqual(['org-A', 'user-1', P, 'app.example.com']);
  });

  it('no env var value reaches any log call', async () => {
    await app.request(`/projects/${P}/env`, json('POST', { key: 'STRIPE_KEY', value: SECRET, isSecret: true }));
    await app.request(`/projects/${P}/env/${ID}`, json('PATCH', { value: SECRET }));
    await app.request(`/projects/${P}/env/bulk`, json('POST', { variables: [{ key: 'STRIPE_KEY', value: SECRET }] }));
    await app.request(`/projects/${P}/env/${ID}`, json('DELETE'));
    expect(logged.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });
});

describe('audit log listing', () => {
  it('is scoped to the caller organization, whatever the query says', async () => {
    const res = await app.request('/activity?organizationId=org-B&limit=10&offset=20', { headers: { 'x-test-org': 'org-A' } });
    expect(res.status).toBe(200);
    expect(getByOrganization).toHaveBeenCalledTimes(1);
    expect(getByOrganization.mock.calls[0][0]).toBe('org-A');
    expect(getByOrganization.mock.calls[0][1]).toMatchObject({ limit: 10, offset: 20 });
  });

  it('filters by source', async () => {
    const res = await app.request('/activity?source=api,webhook');
    expect(res.status).toBe(200);
    expect(getByOrganization.mock.calls[0][1]).toMatchObject({ sources: ['api', 'webhook'] });
  });

  it('rejects an unknown source filter', async () => {
    const res = await app.request('/activity?source=mcp');
    expect(res.status).toBe(400);
    expect(getByOrganization).not.toHaveBeenCalled();
  });

  it('filters by date range', async () => {
    const res = await app.request('/activity?from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z');
    expect(res.status).toBe(200);
    expect(getByOrganization.mock.calls[0][1]).toMatchObject({
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-01-31T23:59:59Z'),
    });
  });

  it('combines date, user and source filters within the caller organization', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const res = await app.request(`/activity?from=2026-01-01T00:00:00Z&userId=${userId}&source=webhook`, {
      headers: { 'x-test-org': 'org-A' },
    });
    expect(res.status).toBe(200);
    expect(getByOrganization.mock.calls[0][0]).toBe('org-A');
    expect(getByOrganization.mock.calls[0][1]).toMatchObject({
      userId,
      sources: ['webhook'],
      from: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('rejects a malformed date', async () => {
    const res = await app.request('/activity?from=yesterday');
    expect(res.status).toBe(400);
    expect(getByOrganization).not.toHaveBeenCalled();
  });

  it('rejects from after to', async () => {
    const res = await app.request('/activity?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z');
    expect(res.status).toBe(400);
    expect(getByOrganization).not.toHaveBeenCalled();
  });

  it('export honours the date range and rejects a malformed one', async () => {
    const ok = await app.request('/activity/export?from=2026-01-01T00:00:00Z');
    expect(ok.status).toBe(200);
    expect(getByOrganization.mock.calls[0][1]).toMatchObject({ from: new Date('2026-01-01T00:00:00Z') });
    const bad = await app.request('/activity/export?to=not-a-date');
    expect(bad.status).toBe(400);
    expect(getByOrganization).toHaveBeenCalledTimes(1);
  });

  it('export honours the source filter', async () => {
    const res = await app.request('/activity/export?source=api');
    expect(res.status).toBe(200);
    expect(getByOrganization.mock.calls[0][1]).toMatchObject({ sources: ['api'] });
  });

  it('returns source and changes on every entry', async () => {
    getByOrganization.mockResolvedValueOnce({
      logs: [
        {
          id: 'a-1', action: 'envvar.updated', description: 'Updated environment variable "K"',
          metadata: { key: 'K' }, source: 'api', changes: { value: { changed: true } },
          createdAt: new Date(), ipAddress: null, user: null, project: null,
        },
      ],
      total: 1,
    } as never);
    const res = await app.request('/activity');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({ source: 'api', changes: { value: { changed: true } } });
  });

  it.each(['member', 'viewer'])('is refused to a %s', async (role) => {
    const res = await app.request('/activity', { headers: { 'x-test-role': role } });
    expect(res.status).toBe(403);
    expect(getByOrganization).not.toHaveBeenCalled();
  });

  it.each(['admin', 'owner'])('is open to an %s', async (role) => {
    const res = await app.request('/activity', { headers: { 'x-test-role': role } });
    expect(res.status).toBe(200);
  });
});
