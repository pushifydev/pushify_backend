import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';

const h = vi.hoisted(() => ({
  selects: [] as unknown[][],
  inserted: [] as Record<string, unknown>[],
  getSSHConnection: vi.fn(),
  adminNotify: vi.fn(),
  sendNotifications: vi.fn(async () => {}),
  performHealthCheck: vi.fn(),
}));

/** A drizzle-ish query chain: every method returns itself, awaiting it yields the next queued result. */
function chain(result: () => unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'leftJoin', 'values', 'onConflictDoUpdate']) c[m] = () => c;
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
        h.inserted.push(v);
        return c;
      };
      return c;
    },
  },
}));
vi.mock('../utils/ssh', () => ({ getSSHConnection: h.getSSHConnection }));
vi.mock('../lib/encryption', () => ({ decrypt: (s: string) => s }));
vi.mock('./admin-notify.service', () => ({ adminNotify: h.adminNotify }));
vi.mock('./notification.service', () => ({ notificationService: { sendNotifications: h.sendNotifications } }));
vi.mock('./healthcheck.service', () => ({ healthCheckService: { performHealthCheck: h.performHealthCheck } }));
vi.mock('../lib/email', () => ({ sendAppDownEmail: vi.fn(), sendAppRecoveredEmail: vi.fn() }));
vi.mock('../lib/ws', () => ({ wsManager: { publish: vi.fn(async () => {}) } }));
vi.mock('../lib/container-resolve', () => ({ restartPushifyContainer: vi.fn() }));
vi.mock('../repositories/organization.repository', () => ({ organizationRepository: { findById: vi.fn(async () => null) } }));
vi.mock('../repositories/deployment-alert.repository', () => ({
  deploymentAlertRepository: { findAlertRecipients: vi.fn(async () => []) },
}));

import { appHealthService, probeTcpPort, type Candidate } from './app-health.service';

let listener: Server;
let openPort: number;
let closedPort: number;

beforeEach(async () => {
  h.selects = [];
  h.inserted = [];
  vi.clearAllMocks();
  listener = createServer((s) => s.destroy());
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', () => r()));
  openPort = (listener.address() as { port: number }).port;
  const tmp = createServer();
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', () => r()));
  closedPort = (tmp.address() as { port: number }).port;
  await new Promise<void>((r) => tmp.close(() => r()));
});
afterEach(async () => {
  await new Promise<void>((r) => listener.close(() => r()));
});

describe('probeTcpPort', () => {
  it('ok when something listens, refused when nothing does', async () => {
    expect(await probeTcpPort('127.0.0.1', openPort, 2000)).toBe('ok');
    expect(await probeTcpPort('127.0.0.1', closedPort, 2000)).toBe('refused');
  });
});

describe('appHealthService.probeServer', () => {
  it('skips everything without an address', async () => {
    expect(await appHealthService.probeServer(null)).toBeUndefined();
    expect(await appHealthService.probeServer({ byos: true, ipv4: null, sshPrivateKey: 'k' })).toBeUndefined();
  });

  it('reports a stopped Docker daemon when SSH works', async () => {
    h.getSSHConnection.mockResolvedValue({
      exec: vi.fn(async (cmd: string) => (cmd === 'true' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' })),
    });
    const outcomes = await appHealthService.probeServer({ byos: true, ipv4: '127.0.0.1', sshPrivateKey: 'key' });
    expect(outcomes?.ssh).toBe('ok');
    expect(outcomes?.docker).toBe('failed');
  });

  it('classifies an SSH timeout and does not ask Docker', async () => {
    h.getSSHConnection.mockRejectedValue(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    const outcomes = await appHealthService.probeServer({ byos: true, ipv4: '127.0.0.1', sshPrivateKey: 'key' });
    expect(outcomes?.ssh).toBe('timeout');
    expect(outcomes?.docker).toBe('skipped');
  });
});

const candidate: Candidate = {
  projectId: 'b1cecd19-0000-4000-8000-000000000000',
  slug: 'app',
  name: 'App',
  organizationId: 'org-1',
  serverId: 'srv-1',
  url: 'https://app.example.com',
  deploymentId: 'dep-1',
  endpoint: '/',
  intervalSeconds: 60,
  timeoutSeconds: 10,
  threshold: 3,
  autoRestart: false,
  requireOk: false,
};

function queueOutage(server: { provider: string; isManaged: boolean }) {
  h.performHealthCheck.mockResolvedValue({ healthy: false, error: 'fetch failed' });
  h.getSSHConnection.mockRejectedValue(Object.assign(new Error('Timed out while waiting for handshake'), { level: 'client-timeout' }));
  h.selects.push(
    // project_health_state: two failures already, so this check confirms the outage
    [{ status: 'up', failCount: 2, downSince: null, notifiedAt: null, reminderStep: 0, downReason: null, diagnostics: null }],
    // servers
    [{ id: 'srv-1', name: 'web-1', ipv4: '127.0.0.1', sshPrivateKey: 'key', ...server }],
    // latest deployment
    [{ status: 'running' }]
  );
}

describe('appHealthService.checkProject when the server gives no answer', () => {
  it('stores which check failed with a next step, and alerts operations for a managed server', async () => {
    queueOutage({ provider: 'hetzner', isManaged: true });
    const status = await appHealthService.checkProject(candidate, new Date('2026-09-22T12:00:00Z'));
    expect(status).toBe('down');

    const state = h.inserted.find((v) => 'diagnostics' in v)!;
    expect(state.downReason).toBe('server_unreachable');
    const diagnostics = state.diagnostics as { failedCheck: string; advice: string; managed: boolean };
    expect(diagnostics.failedCheck).toBe('ssh');
    expect(diagnostics.advice).toMatch(/SSH connection timed out/);
    expect(diagnostics.managed).toBe(true);

    expect(h.adminNotify).toHaveBeenCalledTimes(1);
    expect(h.adminNotify.mock.calls[0][0]).toBe('server.unreachable');
    expect(h.adminNotify.mock.calls[0][1]).toMatchObject({ 'Failed check': 'ssh', IP: '127.0.0.1' });
    // The customer-facing message carries the concrete next step.
    expect(JSON.stringify(h.sendNotifications.mock.calls[0])).toMatch(/SSH connection timed out/);
  });

  it('does not alert operations for a customer-owned (BYOS) server', async () => {
    queueOutage({ provider: 'self_hosted', isManaged: false });
    await appHealthService.checkProject(candidate, new Date('2026-09-22T12:00:00Z'));
    const state = h.inserted.find((v) => 'diagnostics' in v)!;
    expect((state.diagnostics as { managed: boolean; advice: string }).managed).toBe(false);
    expect((state.diagnostics as { advice: string }).advice).not.toMatch(/operations/);
    expect(h.adminNotify).not.toHaveBeenCalled();
  });
});
