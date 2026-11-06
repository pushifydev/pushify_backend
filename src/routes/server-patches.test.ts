import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono, type Context } from 'hono';

/**
 * POST /servers/:serverId/patches/apply: owners and admins queue a security-update run, viewers and
 * members get 403, an API key needs servers:write, and a second run on the same server while one is
 * queued or running gets 409 from the per-server lock.
 *
 * The real auth middleware, scope check, role check, route and lock run (the lock on an in-memory
 * Redis); key validation, the JWT check, membership, the database row, the queue and the audit log
 * are mocked.
 */
const { h } = vi.hoisted(() => ({
  h: {
    roles: {} as Record<string, string>,
    server: null as Record<string, unknown> | null,
    queueAvailable: true,
    jobs: [] as Array<Record<string, unknown>>,
    audit: [] as Array<Record<string, unknown>>,
    redis: new Map<string, string>(),
  },
}));

const KEYS: Record<string, { userId: string; scopes: string }> = {
  pk_live_owner_servers_read: { userId: 'u-owner', scopes: 'servers:read' },
  pk_live_owner_servers_write: { userId: 'u-owner', scopes: 'servers:read,servers:write' },
  pk_live_member_servers_write: { userId: 'u-member', scopes: 'servers:read,servers:write' },
};

vi.mock('../db', () => ({ db: { query: { servers: { findFirst: async () => h.server } } } }));
vi.mock('../services/server.service', () => ({ serverService: {} }));
vi.mock('../repositories/metrics.repository', () => ({ metricsRepository: {} }));
vi.mock('../utils/ssh', () => ({ SSHClient: class {} }));
vi.mock('../lib/server-key-removal', () => ({ UNINSTALL_SCRIPT_URL: 'https://example.com/uninstall.sh' }));
vi.mock('../services/apikey.service', () => ({
  apiKeyService: {
    validate: vi.fn(async (token: string) =>
      KEYS[token]
        ? { userId: KEYS[token].userId, organizationId: 'org-1', apiKey: { id: 'key-1', name: 'k', scopes: KEYS[token].scopes } }
        : null
    ),
  },
  hasScope: (keyScopes: string, required: string) => keyScopes === '*' || keyScopes.split(',').includes(required),
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
vi.mock('../lib/queue', () => ({
  isQueueAvailable: () => h.queueAvailable,
  addServerPatchJob: vi.fn(async (data: Record<string, unknown>) => {
    h.jobs.push(data);
    return { id: `job-${h.jobs.length}` };
  }),
}));
vi.mock('../lib/redis-client', () => ({
  getOptionalRedis: () => ({
    set: async (key: string, value: string, _ex: string, _ttl: number, nx: string) => {
      if (nx === 'NX' && h.redis.has(key)) return null;
      h.redis.set(key, value);
      return 'OK';
    },
    get: async (key: string) => h.redis.get(key) ?? null,
    expire: async () => 1,
    eval: async (_script: string, _n: number, key: string, token: string) => {
      if (h.redis.get(key) !== token) return 0;
      h.redis.delete(key);
      return 1;
    },
  }),
}));
vi.mock('../services/activity.service', () => ({
  activityService: {
    log: vi.fn(async (input: Record<string, unknown>) => {
      h.audit.push(input);
    }),
  },
}));

import { errorHandler } from '../middleware/error-handler';
import { t } from '../i18n';
import { addServerPatchJob } from '../lib/queue';
import { serverPatchLockKey } from '../lib/server-patch-lock';
import { serverRoutes } from './servers';

const SERVER_ID = '00000000-0000-4000-8000-0000000000s1';

const app = new Hono();
app.route('/api/v1/servers', serverRoutes);
app.onError((err, c) => errorHandler(err, c as Context));

const apply = (token: string) =>
  app.request(`/api/v1/servers/${SERVER_ID}/patches/apply`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
  });

async function errorOf(res: Response) {
  return ((await res.json()) as { error: { code?: string; message: string } }).error;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.roles = { 'u-owner': 'owner', 'u-admin': 'admin', 'u-member': 'member', 'u-viewer': 'viewer' };
  h.server = {
    id: SERVER_ID,
    organizationId: 'org-1',
    name: 'web-1',
    status: 'running',
    setupStatus: 'completed',
    ipv4: '203.0.113.10',
    sshPrivateKey: 'encrypted-key',
  };
  h.queueAvailable = true;
  h.jobs = [];
  h.audit = [];
  h.redis = new Map();
});

describe('who may apply security updates', () => {
  it.each(['owner', 'admin'])('an %s queues a run, holding the server lock, and it is audited', async (role) => {
    const res = await apply(`session-${role}`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { jobId: string; serverId: string; status: string } };
    expect(body.data).toEqual({ jobId: 'job-1', serverId: SERVER_ID, status: 'queued' });

    expect(h.jobs).toHaveLength(1);
    const job = h.jobs[0] as { serverId: string; organizationId: string; requestedBy: string; lockToken: string };
    expect(job).toMatchObject({ serverId: SERVER_ID, organizationId: 'org-1', requestedBy: `u-${role}` });
    expect(h.redis.get(serverPatchLockKey(SERVER_ID))).toBe(job.lockToken);

    expect(h.audit).toEqual([
      expect.objectContaining({
        organizationId: 'org-1',
        userId: `u-${role}`,
        action: 'server.patches_requested',
        metadata: { serverId: SERVER_ID, serverName: 'web-1', jobId: 'job-1' },
        ipAddress: '203.0.113.7',
        source: 'ui',
      }),
    ]);
  });

  it.each(['member', 'viewer'])('a %s gets 403 and nothing is queued or locked', async (role) => {
    const res = await apply(`session-${role}`);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toBe(t('en', 'errors', 'forbidden'));
    expect(addServerPatchJob).not.toHaveBeenCalled();
    expect(h.redis.size).toBe(0);
    expect(h.audit).toEqual([]);
  });

  it('someone outside the organization gets 403', async () => {
    delete h.roles['u-owner'];
    const res = await apply('session-owner');
    expect(res.status).toBe(403);
    expect(addServerPatchJob).not.toHaveBeenCalled();
  });

  it('an API key needs servers:write', async () => {
    const res = await apply('pk_live_owner_servers_read');
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toBe(t('en', 'apiKeys', 'insufficientScope'));
    expect(addServerPatchJob).not.toHaveBeenCalled();
  });

  it('an API key with servers:write acts with the role of its creator', async () => {
    expect((await apply('pk_live_member_servers_write')).status).toBe(403);
    const res = await apply('pk_live_owner_servers_write');
    expect(res.status).toBe(202);
    expect(h.audit[0]).toMatchObject({ action: 'server.patches_requested', userId: 'u-owner', source: 'api' });
  });
});

describe('one run per server', () => {
  it('a second request while a run is queued or running gets 409', async () => {
    expect((await apply('session-owner')).status).toBe(202);
    const res = await apply('session-admin');
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('PATCH_RUN_IN_PROGRESS');
    expect(h.jobs).toHaveLength(1);
  });

  it('the lock is given back when the job cannot be queued', async () => {
    vi.mocked(addServerPatchJob).mockRejectedValueOnce(new Error('redis down'));
    expect((await apply('session-owner')).status).toBe(500);
    expect(h.redis.size).toBe(0);
    expect((await apply('session-owner')).status).toBe(202);
  });
});

describe('servers that cannot be patched', () => {
  it('404 for a server of another organization (or none)', async () => {
    h.server = null;
    const res = await apply('session-owner');
    expect(res.status).toBe(404);
    expect(addServerPatchJob).not.toHaveBeenCalled();
  });

  it.each([
    [{ setupStatus: 'installing' }, 'SERVER_NOT_READY'],
    [{ status: 'stopped' }, 'SERVER_NOT_READY'],
    [{ sshPrivateKey: null }, 'SSH_UNAVAILABLE'],
  ])('400 for %o', async (patch, code) => {
    Object.assign(h.server!, patch);
    const res = await apply('session-owner');
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe(code);
    expect(h.redis.size).toBe(0);
  });

  it('503 without a queue, and no lock is left behind', async () => {
    h.queueAvailable = false;
    const res = await apply('session-owner');
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe('QUEUE_UNAVAILABLE');
    expect(h.redis.size).toBe(0);
  });
});
