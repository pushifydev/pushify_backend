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
  // The container inspection on the project's host (lib/container-down-cause.ts prints this).
  execOnProjectHost: vi.fn(async (..._args: unknown[]) => ({ ok: false, stdout: '' })),
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
vi.mock('../lib/project-host-exec', () => ({ execOnProjectHost: h.execOnProjectHost }));
vi.mock('../workers/log-collector', () => ({
  getProjectLogMasker: async () => ({ mask: (text: string) => text.replace(/postgres:\/\/\S+/g, '••••••') }),
}));
vi.mock('../repositories/organization.repository', () => ({ organizationRepository: { findById: vi.fn(async () => null) } }));
vi.mock('../repositories/deployment-alert.repository', () => ({
  deploymentAlertRepository: { findAlertRecipients: vi.fn(async () => []) },
}));

import { appHealthService, type Candidate } from './app-health.service';
import { opsSignalsService } from './ops-signals.service';
import { adminNotify } from './admin-notify.service';

const defaultLatestDeploy = { ...h.latestDeploy };

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
  Object.assign(h.latestDeploy, defaultLatestDeploy);
  vi.clearAllMocks();
  h.execOnProjectHost.mockResolvedValue({ ok: false, stdout: '' });
});

async function b1cecd19(): Promise<Candidate> {
  const port = await closedPort();
  return {
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
    port: 3000,
  };
}

describe('site down with ECONNREFUSED behind a failed Docker build: health check → stored record → ops diagnosis', () => {
  it('is diagnosed as "container not running / port not listening", not as a build failure', async () => {
    const candidate = await b1cecd19();
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
    // The container could not be inspected here, and the record says so instead of guessing.
    expect(h.stored).toMatchObject({ statusCode: null, error: 'fetch failed (ECONNREFUSED)' });
    expect(h.stored!.diagnostics).toMatchObject({ checks: [], failedCheck: null, container: { state: 'unknown', cause: null } });
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

  it('inspects the container on ECONNREFUSED and records a concrete cause (crash_loop) instead of the build, without a second alert', async () => {
    const candidate = await b1cecd19();
    // What the server prints for b1cecd19's container: crash-looping on a database it cannot reach.
    h.execOnProjectHost.mockResolvedValue({
      ok: true,
      stdout: [
        '@@pushify:inspect pushify-app-blue',
        '{"status":"restarting","exitCode":1,"oomKilled":false,"restartCount":4127,"finishedAt":"2026-10-21T07:59:58Z","ports":{"3000/tcp":[{"HostIp":"0.0.0.0","HostPort":"45001"}]}}',
        '@@pushify:listen',
        '@@pushify:logs',
        'Connecting to postgres://app:s3cret@10.0.0.5:5432/app',
        'Error: connect ECONNREFUSED 10.0.0.5:5432',
      ].join('\n'),
    });
    h.selects.push(
      [{ status: 'up', failCount: 2, downSince: null, notifiedAt: null, reminderStep: 0, downReason: null, diagnostics: null }],
      [{ id: 'srv-1', name: 'web-1', provider: 'hetzner', isManaged: true, ipv4: null, sshPrivateKey: null }],
      [{ status: h.latestDeploy.status }]
    );

    const at = new Date('2026-09-22T23:00:00Z');
    expect(await appHealthService.checkProject(candidate, at)).toBe('down');

    // The inspection ran on the project's host, for this project's container.
    expect(h.execOnProjectHost).toHaveBeenCalledTimes(1);
    expect(h.execOnProjectHost.mock.calls[0][0]).toEqual({ id: candidate.projectId, serverId: 'srv-1' });
    expect(String(h.execOnProjectHost.mock.calls[0][1])).toContain("'^pushify-app(-(blue|green))? '");

    // The record carries the cause code, the facts and a hint — not "build".
    const container = (h.stored!.diagnostics as { container: Record<string, unknown> }).container;
    expect(container).toMatchObject({ cause: 'crash_loop', state: 'restarting', exitCode: 1, restartCount: 4127, oomKilled: false, configuredPort: 3000 });
    expect(String(container.hint)).toMatch(/keeps crashing on start/);
    expect(String(container.hint)).not.toMatch(/build/i);
    // Its last log lines are kept for the project page, with secrets masked.
    expect(String(container.logTail)).toContain('Error: connect ECONNREFUSED 10.0.0.5:5432');
    expect(String(container.logTail)).not.toContain('s3cret');
    // Reaching the container means the server answers: the app, not an unreachable server.
    expect(h.stored!.downReason).toBe('app_error');

    // One alert for the outage, unchanged; the cause is shown, not mailed.
    expect(h.sendNotifications).toHaveBeenCalledTimes(1);
    expect((h.sendNotifications.mock.calls[0][2] as { message: string }).message).not.toMatch(/build/i);

    // The ops diagnosis names the cause; no container name or log line goes out.
    const { sitesDown } = await opsSignalsService.getSignals();
    expect(sitesDown[0].diagnosis).toMatchObject({ kind: 'container_not_running', cause: 'crash_loop', userSide: true });
    expect(sitesDown[0].diagnosis.summary).toContain('the app container is restarting (exit code 1, 4127 restarts) (crash_loop)');
    expect(sitesDown[0].diagnosis.summary).not.toMatch(/build|pushify-app|10\.0\.0\.5/i);

    // The next check a minute later: still down, nothing sent again, the cause stays on the record.
    const first = h.stored!;
    h.selects.push([{ ...first, status: 'down' }]);
    expect(await appHealthService.checkProject(candidate, new Date(at.getTime() + 60_000))).toBe('down');
    expect(h.sendNotifications).toHaveBeenCalledTimes(1);
    expect(h.execOnProjectHost).toHaveBeenCalledTimes(1);
    expect((h.stored!.diagnostics as { container: { cause: string } }).container.cause).toBe('crash_loop');
  });

  it('re-diagnoses a record opened before container inspection existed, moves it to build_failed, and sends nothing', async () => {
    const candidate = await b1cecd19();
    // The latest deployment failed on the project's side (its own build script).
    Object.assign(h.latestDeploy, { error: '[Project] Application build failed: npm ERR! Missing script: "build"' });
    // On the server: the app container exited and nothing restarted it.
    h.execOnProjectHost.mockResolvedValue({
      ok: true,
      stdout: [
        '@@pushify:inspect pushify-app',
        '{"status":"exited","exitCode":1,"oomKilled":false,"restartCount":0,"finishedAt":"2026-09-22T22:53:10Z","ports":{"3000/tcp":[{"HostIp":"0.0.0.0","HostPort":"45001"}]}}',
        '@@pushify:listen',
        '@@pushify:logs',
        'npm ERR! Missing script: "build"',
      ].join('\n'),
    });
    const downSince = new Date('2026-09-22T22:54:41Z');
    h.selects.push(
      // The record as the code before the fix left it: down for a month, alert and both reminders
      // sent, the build blamed, and server checks with no container in them.
      [
        {
          status: 'down',
          failCount: 43000,
          statusCode: null,
          error: 'fetch failed (ECONNREFUSED)',
          downSince,
          notifiedAt: new Date('2026-09-25T22:54:41Z'),
          reminderStep: 2,
          downReason: 'deploy_failed',
          diagnostics: {
            checkedAt: '2026-10-22T07:00:00.000Z',
            checks: [
              { check: 'ssh', outcome: 'ok', ok: true, advice: null },
              { check: 'docker', outcome: 'ok', ok: true, advice: null },
              { check: 'http_port', outcome: 'ok', ok: true, advice: null },
              { check: 'https_port', outcome: 'ok', ok: true, advice: null },
            ],
            failedCheck: null,
            advice: null,
            managed: true,
          },
        },
      ],
      [{ id: 'srv-1', name: 'web-1', provider: 'hetzner', isManaged: true, ipv4: null, sshPrivateKey: null }],
      [{ status: h.latestDeploy.status }]
    );

    const at = new Date('2026-10-22T09:00:00Z');
    expect(await appHealthService.checkProject(candidate, at)).toBe('down');

    // The stored diagnostics were due, so the new code ran on the old record: the container was inspected.
    expect(h.execOnProjectHost).toHaveBeenCalledTimes(1);
    const container = (h.stored!.diagnostics as { container: Record<string, unknown> }).container;
    expect(container).toMatchObject({ state: 'exited', cause: 'container_exited', exitCode: 1, restartCount: 0, configuredPort: 3000 });
    expect(h.stored!.downReason).toBe('app_error');
    // Same outage: its start, its alert and its reminders are kept as they were.
    expect(h.stored).toMatchObject({ status: 'down', statusCode: null, error: 'fetch failed (ECONNREFUSED)', downSince, reminderStep: 2 });
    expect(h.stored!.notifiedAt).toEqual(new Date('2026-09-25T22:54:41Z'));

    // No notification of any kind for the re-diagnosis.
    expect(h.sendNotifications).not.toHaveBeenCalled();
    expect(h.sendAppDownEmail).not.toHaveBeenCalled();
    expect(adminNotify).not.toHaveBeenCalled();

    // The ops record now carries the container state, the port result and the latest deploy, and
    // waits on the user's build instead of standing as a platform outage.
    const { sitesDown } = await opsSignalsService.getSignals();
    expect(sitesDown).toHaveLength(1);
    const [site] = sitesDown;
    expect(site.latestDeploy).toMatchObject({ status: 'failed', blame: 'project', label: 'Application build failed' });
    expect(site.diagnosis).toMatchObject({ kind: 'build_failed', userSide: true, cause: 'container_exited' });
    expect(site.diagnosis.summary).toContain('fetch failed (ECONNREFUSED)');
    expect(site.diagnosis.summary).toContain('the app container is exited (exit code 1, 0 restarts)');
    expect(site.diagnosis.summary).toContain('nothing listens on port 3000');
    expect(site.diagnosis.summary).toContain('the latest deployment failed (Application build failed, project side)');
    expect(site.diagnosis.summary).not.toMatch(/pushify-app|npm ERR/);

    // The next round: nothing sent, no second inspection within the hour, the diagnosis stays.
    h.selects.push([{ ...h.stored!, status: 'down' }]);
    expect(await appHealthService.checkProject(candidate, new Date(at.getTime() + 60_000))).toBe('down');
    expect(h.sendNotifications).not.toHaveBeenCalled();
    expect(h.sendAppDownEmail).not.toHaveBeenCalled();
    expect(h.execOnProjectHost).toHaveBeenCalledTimes(1);
    expect((h.stored!.diagnostics as { container: { cause: string } }).container.cause).toBe('container_exited');
  });
});
