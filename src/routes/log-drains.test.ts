import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono, type Context } from 'hono';

/**
 * /api/v1/log-drains: any member lists drains (never the secret), only owners and admins create
 * them, API keys are refused, input is validated, the secret is stored encrypted and the change
 * is audited and synced. Real auth middleware, route and service; database, membership, audit
 * and the server sync are mocked.
 */
const { h } = vi.hoisted(() => ({
  h: {
    roles: {} as Record<string, string>,
    rows: [] as Array<Record<string, unknown>>,
    inserted: [] as Array<Record<string, unknown>>,
    audit: [] as Array<Record<string, unknown>>,
  },
}));

function thenable(result: () => unknown): unknown {
  const target = new Proxy(() => undefined, {
    get: (_t, prop) =>
      prop === 'then'
        ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject)
        : () => target,
  });
  return target;
}

vi.mock('../db', () => ({
  db: {
    select: () => thenable(() => h.rows),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        h.inserted.push(v);
        return { returning: async () => [{ id: 'd-new', lastTestedAt: null, lastTestOk: null, lastTestError: null, createdAt: new Date(), updatedAt: new Date(), ...v }] };
      },
    }),
  },
}));
vi.mock('../utils/ssh', () => ({ SSHClient: class {} }));
vi.mock('../services/apikey.service', () => ({
  apiKeyService: {
    validate: vi.fn(async (token: string) =>
      token === 'pk_live_owner' ? { userId: 'u-owner', organizationId: 'org-1', apiKey: { id: 'key-1', name: 'k', scopes: '*' } } : null
    ),
  },
  hasScope: () => true,
}));
vi.mock('../lib/jwt', () => ({
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
vi.mock('../repositories/project.repository', () => ({ projectRepository: { findById: async () => null } }));
vi.mock('../services/activity.service', () => ({
  activityService: { log: vi.fn(async (input: Record<string, unknown>) => void h.audit.push(input)) },
}));

import { errorHandler } from '../middleware/error-handler';
import { decrypt } from '../lib/encryption';
import { logDrainService } from '../services/log-drain.service';
import { logDrainRoutes } from './log-drains';

const app = new Hono();
app.route('/api/v1/log-drains', logDrainRoutes);
app.onError((err, c) => errorHandler(err, c as Context));

const call = (method: string, token: string, body?: unknown) =>
  app.request('/api/v1/log-drains', {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const sync = vi.spyOn(logDrainService, 'syncInBackground').mockImplementation(() => undefined);

beforeEach(() => {
  h.roles = { 'u-owner': 'owner', 'u-member': 'member', 'u-viewer': 'viewer' };
  h.rows = [];
  h.inserted = [];
  h.audit = [];
  sync.mockClear();
});

describe('/api/v1/log-drains', () => {
  it('refuses API keys', async () => {
    const res = await call('GET', 'pk_live_owner');
    expect(res.status).toBe(403);
  });

  it('lists drains to any member without the secret', async () => {
    h.rows = [
      {
        id: 'd1', organizationId: 'org-1', projectId: null, name: 'Loki', type: 'loki', endpoint: 'https://loki.example.com',
        options: { username: '123' }, secretEncrypted: 'enc', sendLogs: true, sendMetrics: false, enabled: true,
        lastTestedAt: null, lastTestOk: null, lastTestError: null, createdAt: new Date(), updatedAt: new Date(),
      },
    ];
    const res = await call('GET', 'session-viewer');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({ id: 'd1', type: 'loki', hasSecret: true, options: { username: '123' } });
    expect(JSON.stringify(body)).not.toContain('enc');
  });

  it('lets only owners and admins create, and validates the input', async () => {
    expect((await call('POST', 'session-member', { name: 'x', type: 'http', endpoint: 'https://x.example.com' })).status).toBe(403);
    expect((await call('POST', 'session-owner', { name: 'x', type: 'syslog' })).status).toBe(400);
    const missingKey = await call('POST', 'session-owner', { name: 'DD', type: 'datadog' });
    expect(missingKey.status).toBe(400);
    expect((await missingKey.json()).error.message).toBe('secret is required for datadog drains');
    expect(h.inserted).toHaveLength(0);
    expect(sync).not.toHaveBeenCalled();
  });

  it('stores the secret encrypted, never returns it, audits and syncs', async () => {
    const res = await call('POST', 'session-owner', { name: ' Datadog ', type: 'datadog', secret: 'dd-api-key-123', sendMetrics: true });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({ id: 'd-new', name: 'Datadog', type: 'datadog', endpoint: null, hasSecret: true, sendLogs: true, sendMetrics: true });
    expect(body.data.options).toEqual({ site: 'datadoghq.com' });
    expect(JSON.stringify(body)).not.toContain('dd-api-key-123');
    expect(h.inserted[0].secretEncrypted).not.toBe('dd-api-key-123');
    expect(decrypt(h.inserted[0].secretEncrypted as string)).toBe('dd-api-key-123');
    expect(h.audit[0]).toMatchObject({ action: 'log_drain.created', organizationId: 'org-1', userId: 'u-owner' });
    expect(JSON.stringify(h.audit)).not.toContain('dd-api-key-123');
    expect(sync).toHaveBeenCalledWith('org-1');
  });
});
