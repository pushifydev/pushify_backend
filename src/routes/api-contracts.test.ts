import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';

/**
 * Response shapes promised to the dashboard in docs/api-contracts.md. The real route, service and
 * report builders run; only auth, the database and SSH are replaced. If a field is renamed, added
 * or removed here, update the document in the same change.
 *
 *   GET /api/v1/projects/:projectId/analytics   (metrics.ts → traffic-analytics.service)
 *   GET /api/v1/servers/:serverId/health        (servers.ts → server-health-scan)
 */

const h = vi.hoisted(() => ({
  trafficRows: [] as Record<string, unknown>[],
  projectSettings: {} as Record<string, unknown>,
  server: { id: 'srv-1', setupStatus: 'completed' } as Record<string, unknown>,
  serverRow: { ipv4: '203.0.113.7', sshPrivateKey: 'k' } as Record<string, unknown> | null,
}));

vi.mock('../middleware/auth', () => {
  const mw = async (c: Context, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('organizationId', 'org-1');
    c.set('locale', 'en');
    await next();
  };
  return { authMiddleware: mw, combinedAuthMiddleware: mw };
});
vi.mock('../middleware/apikey-auth', () => ({
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  rejectApiKeyAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../db', () => ({
  db: {
    query: {
      projects: { findFirst: async () => ({ settings: h.projectSettings }) },
      servers: { findFirst: async () => h.serverRow },
    },
    // traffic-analytics.service reads the hourly rows; server-health-scan reads the active project slugs
    select: (cols?: Record<string, unknown>) => ({
      from: () => ({
        where: async () => (cols && 'slug' in cols ? [{ slug: 'web' }] : h.trafficRows),
      }),
    }),
  },
}));
vi.mock('../repositories/project.repository', () => ({
  projectRepository: { findById: async (id: string) => ({ id, organizationId: 'org-1' }) },
}));
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: { findMember: async () => ({ userId: 'user-1', role: 'viewer' }) },
}));
vi.mock('../lib/member-project-scope', () => ({
  assertMemberProjectScope: async () => undefined,
  getMemberAllowedProjectIds: async () => null,
}));
vi.mock('../services/metrics.service', () => ({ metricsService: {} }));
vi.mock('../repositories/metrics.repository', () => ({ metricsRepository: {} }));
vi.mock('../services/server.service', () => ({
  serverService: { getServer: async () => h.server },
}));
vi.mock('../lib/encryption', () => ({ decrypt: (s: string) => s }));
vi.mock('../utils/ssh', () => ({
  SSHClient: class {},
  getSSHConnection: async () => ({
    exec: async (cmd: string) => {
      if (cmd.includes('PUSHIFY_PATCH')) {
        return {
          code: 0,
          stdout: [
            'PUSHIFY_PATCH apt=yes',
            'PUSHIFY_PATCH aptcheck=12;3',
            'PUSHIFY_PATCH reboot=yes',
            'PUSHIFY_PATCH uu_installed=yes',
            'PUSHIFY_PATCH uu_periodic=1',
            'PUSHIFY_PATCH uu_timer=enabled',
            'PUSHIFY_PATCH uu_last=1793000000',
          ].join('\n'),
          stderr: '',
        };
      }
      if (cmd.startsWith('df ')) return { code: 0, stdout: '41 52428800 /\n', stderr: '' };
      return { code: 0, stdout: 'pushify-web|Up 2 hours|0.0.0.0:3001->3000/tcp\npushify-old|Exited (0) 3 days ago|\n', stderr: '' };
    },
    disconnect: () => undefined,
  }),
}));

const { metricsRoutes } = await import('./metrics');
const { serverRoutes } = await import('./servers');
const { errorHandler } = await import('../middleware/error-handler');

function app() {
  const a = new Hono();
  a.onError(errorHandler);
  a.route('/api/v1/projects', metricsRoutes);
  a.route('/api/v1/servers', serverRoutes);
  return a;
}

const PROJECT_ID = '0b9f2c1e-5d3a-4c8e-9f1a-2b3c4d5e6f70';
const NOW = new Date('2026-11-06T12:34:00.000Z');

describe('GET /api/v1/projects/:projectId/analytics', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    h.projectSettings = {};
    h.trafficRows = [
      {
        hour: new Date('2026-11-06T12:00:00.000Z'),
        requests: 200,
        status2xx: 180,
        status3xx: 5,
        status4xx: 10,
        status5xx: 5,
        bytesSent: 1048576,
        latencyBuckets: [100, 50, 20, 10, 10, 5, 3, 1, 1, 0, 0],
      },
    ];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers { data } with totals and one point per hour, oldest first', async () => {
    const res = await app().request(`/api/v1/projects/${PROJECT_ID}/analytics?range=24h`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Object.keys(body)).toEqual(['data']);
    const data = body.data;
    expect(Object.keys(data).sort()).toEqual(['bucket', 'enabled', 'range', 'retentionDays', 'series', 'totals']);
    expect(data).toMatchObject({ enabled: true, range: '24h', bucket: 'hour', retentionDays: 14 });

    expect(Object.keys(data.totals).sort()).toEqual([
      'bytesSent',
      'errorRate4xx',
      'errorRate5xx',
      'p95LatencyMs',
      'requests',
      'status2xx',
      'status3xx',
      'status4xx',
      'status5xx',
    ]);
    expect(data.totals).toMatchObject({
      requests: 200,
      status2xx: 180,
      status3xx: 5,
      status4xx: 10,
      status5xx: 5,
      bytesSent: 1048576,
      errorRate4xx: 0.05,
      errorRate5xx: 0.025,
      p95LatencyMs: 250,
    });

    expect(data.series).toHaveLength(24);
    for (const point of data.series) {
      expect(Object.keys(point).sort()).toEqual([
        'bytesSent',
        'hour',
        'p95LatencyMs',
        'requests',
        'status2xx',
        'status3xx',
        'status4xx',
        'status5xx',
      ]);
    }
    expect(data.series[0]).toEqual({
      hour: '2026-11-05T13:00:00.000Z',
      requests: 0,
      status2xx: 0,
      status3xx: 0,
      status4xx: 0,
      status5xx: 0,
      bytesSent: 0,
      p95LatencyMs: null,
    });
    expect(data.series[23]).toEqual({
      hour: '2026-11-06T12:00:00.000Z',
      requests: 200,
      status2xx: 180,
      status3xx: 5,
      status4xx: 10,
      status5xx: 5,
      bytesSent: 1048576,
      p95LatencyMs: 250,
    });
  });

  it('defaults to 24h, serves 168 points for 7d and reports enabled=false when the project opted out', async () => {
    const byDefault = await (await app().request(`/api/v1/projects/${PROJECT_ID}/analytics`)).json();
    expect(byDefault.data.range).toBe('24h');
    expect(byDefault.data.series).toHaveLength(24);

    h.projectSettings = { trafficAnalytics: false };
    const week = await (await app().request(`/api/v1/projects/${PROJECT_ID}/analytics?range=7d`)).json();
    expect(week.data.range).toBe('7d');
    expect(week.data.enabled).toBe(false);
    expect(week.data.series).toHaveLength(168);
  });

  it('refuses any other range with 400 BAD_REQUEST', async () => {
    const res = await app().request(`/api/v1/projects/${PROJECT_ID}/analytics?range=30d`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'range must be one of: 24h, 7d' },
    });
  });
});

describe('GET /api/v1/servers/:serverId/health', () => {
  beforeEach(() => {
    h.server = { id: 'srv-1', setupStatus: 'completed' };
    h.serverRow = { ipv4: '203.0.113.7', sshPrivateKey: 'k' };
  });

  it('answers { data } with disk, orphans, container count and the OS patch status', async () => {
    const res = await app().request('/api/v1/servers/srv-1/health');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Object.keys(body)).toEqual(['data']);
    const data = body.data;
    expect(Object.keys(data).sort()).toEqual(['disk', 'lastAutoPatch', 'orphans', 'patch', 'pushifyContainerCount']);
    // No scheduled automatic security update run yet
    expect(data.lastAutoPatch).toBeNull();

    expect(Object.keys(data.disk).sort()).toEqual([
      'availGb',
      'critical',
      'measured',
      'message',
      'mount',
      'ok',
      'usedPercent',
      'warn',
    ]);
    expect(data.disk).toEqual({
      ok: true,
      usedPercent: 41,
      availGb: 50,
      mount: '/',
      warn: false,
      critical: false,
      message: '💾 Disk OK: 41% used (50 GB free on /)',
      measured: true,
    });

    expect(data.pushifyContainerCount).toBe(2);
    expect(data.orphans).toEqual([{ name: 'pushify-old', slug: 'old', status: 'Exited (0) 3 days ago', ports: '' }]);

    expect(Object.keys(data.patch).sort()).toEqual([
      'checkedAt',
      'pending',
      'rebootRequired',
      'security',
      'unattendedUpgrades',
    ]);
    expect(data.patch).toMatchObject({
      pending: 12,
      security: 3,
      rebootRequired: true,
      unattendedUpgrades: { enabled: true, lastRunAt: new Date(1793000000 * 1000).toISOString() },
    });
    expect(Object.keys(data.patch.unattendedUpgrades).sort()).toEqual(['enabled', 'lastRunAt']);
    expect(typeof data.patch.checkedAt).toBe('string');
  });

  it('returns the outcome of the last scheduled security update run as lastAutoPatch', async () => {
    const lastAutoPatch = {
      at: '2026-11-08T03:04:00.000Z',
      status: 'applied',
      packagesApplied: 4,
      rebootRequired: true,
      summary: 'Installed 4 security updates (apt); reboot required',
      error: null,
      code: null,
    };
    h.serverRow = { ipv4: '203.0.113.7', sshPrivateKey: 'k', lastAutoPatch };
    const res = await app().request('/api/v1/servers/srv-1/health');
    expect(res.status).toBe(200);
    expect((await res.json()).data.lastAutoPatch).toEqual(lastAutoPatch);
  });

  it('answers 400 SERVER_NOT_READY before setup is completed', async () => {
    h.server = { id: 'srv-1', setupStatus: 'installing' };
    const res = await app().request('/api/v1/servers/srv-1/health');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'SERVER_NOT_READY', message: 'Server setup must be completed before running a health scan' },
    });
  });

  it('answers 400 SSH_UNAVAILABLE when the server has no address or SSH key', async () => {
    h.serverRow = { ipv4: null, sshPrivateKey: null };
    const res = await app().request('/api/v1/servers/srv-1/health');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('SSH_UNAVAILABLE');
  });
});
