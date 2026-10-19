import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from 'node:net';

/**
 * End to end, from the health check to the ops diagnosis, for the b1cecd19 case: the site's port
 * refuses connections (a real fetch to a closed local port, so the error really comes out of
 * undici as "fetch failed" + ECONNREFUSED), the latest deployment is a failed Docker build, and no
 * server checks could be run. The stored record must keep ECONNREFUSED with statusCode null, the
 * down reason must not be deploy_failed, and the ops diagnosis built from that very record must
 * say "container not running / nothing listens on the port" — never "build failed".
 *
 * Only the database (an in-memory row store), SSH and outbound notifications are fakes.
 */
const h = vi.hoisted(() => ({
  selects: [] as unknown[][],
  stored: null as Record<string, unknown> | null,
  sendNotifications: vi.fn(async (..._args: unknown[]) => {}),
  sendAppDownEmail: vi.fn(),
  latestDeploy: { status: 'failed', error: '[Project] Docker build failed: exit code 1', createdAt: '2026-09-22T22:50:00Z' },
}));

function chain(result: () => unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'leftJoin', 'innerJoin', 'values', 'onConflictDoUpdate', 'returning']) c[m] = () => c;
  c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
  c.catch = () => Promise.resolve();
  return c;
}

vi.mock('../db', () => ({
  db: {
    select: () => chain(() => h.selects.shift() ?? []),
    insert: () => {
      const c = chain(() => []);
      c.values = (v: Record<string, unknown>) => {
        // The project_health_state upsert is the row that carries downReason.
        if ('downReason' in v) h.stored = v;
        return c;
      };
      return c;
    },
    // What ops signals reads: the stored health row joined with the project's latest deployment.
    execute: async (query: unknown) => {
      if (!JSON.stringify(query).includes('project_health_state') || !h.stored) return { rows: [] };
      const s = h.stored;
      return {
        rows: [
          {
            projectId: s.projectId,
            downSince: (s.downSince as Date | null)?.toISOString() ?? null,
            statusCode: s.statusCode,
            error: s.error,
            downReason: s.downReason,
            diagnostics: s.diagnostics,
            latestStatus: h.latestDeploy.status,
            latestCreatedAt: h.latestDeploy.createdAt,
            latestError: h.latestDeploy.error,
            managed: null,
            serverStatus: null,
            serverLastSeenAt: null,
            lastSuccessfulDeployAt: '2026-09-01T00:00:00Z',
            ownerLastLoginAt: null,
          },
        ],
      };
    },
  },
}));
vi.mock('../lib/ssrf-guard', () => ({ assertPublicUrl: async () => {} }));
vi.mock('../utils/ssh', () => ({ getSSHConnection: vi.fn(async () => { throw new Error('no ssh in this test'); }) }));
vi.mock('./admin-notify.service', () => ({ adminNotify: vi.fn() }));
vi.mock('./notification.service', () => ({ notificationService: { sendNotifications: h.sendNotifications } }));
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/email')>()),
  sendAppDownEmail: h.sendAppDownEmail,
  sendAppRecoveredEmail: vi.fn(),
}));
vi.mock('../lib/ws', () => ({ wsManager: { publish: vi.fn(async () => {}) } }));
vi.mock('../lib/container-resolve', () => ({ restartPushifyContainer: vi.fn() }));
vi.mock('../repositories/organization.repository', () => ({ organizationRepository: { findById: vi.fn(async () => null) } }));
vi.mock('../repositories/deployment-alert.repository', () => ({
  deploymentAlertRepository: { findAlertRecipients: vi.fn(async () => []) },
}));

import { appHealthService, type Candidate } from './app-health.service';
import { opsSignalsService } from './ops-signals.service';

async function closedPort(): Promise<number> {
  const tmp = createServer();
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', () => r()));
  const port = (tmp.address() as { port: number }).port;
  await new Promise<void>((r) => tmp.close(() => r()));
  return port;
}

beforeEach(() => {
  h.selects = [];
  h.stored = null;
  vi.clearAllMocks();
});

describe('site down with ECONNREFUSED behind a failed Docker build: health check → stored record → ops diagnosis', () => {
  it('is diagnosed as "container not running / port not listening", not as a build failure', async () => {
    const port = await closedPort();
    const candidate: Candidate = {
      projectId: 'b1cecd19-0000-4000-8000-000000000000',
      slug: 'app',
      name: 'App',
      organizationId: 'org-1',
      serverId: 'srv-1',
      url: `http://127.0.0.1:${port}`,
      deploymentId: 'dep-1',
      endpoint: '/',
      intervalSeconds: 60,
      timeoutSeconds: 5,
      threshold: 3,
      autoRestart: false,
      requireOk: false,
    };
    h.selects.push(
      // project_health_state: two failures already, so this check confirms the outage
      [{ status: 'up', failCount: 2, downSince: null, notifiedAt: null, reminderStep: 0, downReason: null, diagnostics: null }],
      // servers: no address to probe, so no server checks get stored
      [{ id: 'srv-1', name: 'web-1', provider: 'hetzner', isManaged: true, ipv4: null, sshPrivateKey: null }],
      // latest deployment: the failed Docker build
      [{ status: h.latestDeploy.status }]
    );

    const status = await appHealthService.checkProject(candidate, new Date('2026-09-22T23:00:00Z'));
    expect(status).toBe('down');

    // The record: the network error code is kept, no HTTP status, and the build is not blamed.
    expect(h.stored).toMatchObject({ statusCode: null, error: 'fetch failed (ECONNREFUSED)', diagnostics: null });
    expect(h.stored!.downReason).not.toBe('deploy_failed');
    const message = (h.sendNotifications.mock.calls[0]?.[2] as { message: string } | undefined)?.message ?? '';
    expect(message).toContain('ECONNREFUSED');
    expect(message).not.toMatch(/deploy_failed|build/i);

    // The diagnosis ops reads, built from that same record.
    const { sitesDown } = await opsSignalsService.getSignals();
    expect(sitesDown).toHaveLength(1);
    const [site] = sitesDown;
    expect(site).toMatchObject({ projectId: candidate.projectId, statusCode: null, error: 'fetch failed (ECONNREFUSED)' });
    expect(site.latestDeploy?.status).toBe('failed');
    expect(site.diagnosis.kind).toBe('container_not_running');
    expect(site.diagnosis.kind).not.toBe('build_failed');
    expect(site.diagnosis.summary).toContain('ECONNREFUSED');
    expect(site.diagnosis.summary).toContain('nothing listens on the port');
    expect(site.diagnosis.summary).not.toMatch(/build/i);
  });
});
