import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono, type Context } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Deleting with an API key needs the resource's `:delete` scope: a key with `:write` but not
 * `:delete` gets 403 (`insufficientScope`) on every DELETE route before any service is called, a
 * key with `:delete` (or `*`) and a dashboard session go through, and `:write` keeps working for
 * everything that is not a delete. Migration 0097 gives existing `:write` keys the `:delete` scope.
 *
 * The real authMiddleware, scope checks and routes run, mounted as in routes/index.ts; key
 * validation, the JWT check and every service behind the routes are mocked.
 */
const { h, pass, serviceProxy } = vi.hoisted(() => {
  const h = { validate: vi.fn(), verifyToken: vi.fn(), service: vi.fn() };
  return {
    h,
    pass: async (_c: unknown, next: () => Promise<void>) => next(),
    // Every service method is the same spy: the test is about reaching it at all.
    serviceProxy: () => new Proxy({}, { get: () => h.service }),
  };
});

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
vi.mock('../lib/org-two-factor', () => ({
  isExemptFromOrgTwoFactor: () => true,
  isOrganizationTwoFactorRequired: async () => false,
  userHasTwoFactorEnabled: async () => true,
  orgTwoFactorRequiredError: () => new Error('2fa required'),
}));
vi.mock('../middleware/rate-limit', () => ({ applyPlanApiRateLimit: pass }));
vi.mock('../lib/org-access', () => ({ requireOrgMember: h.service, requireMinRole: () => pass, roleAtLeast: () => true }));
vi.mock('../db', () => ({ db: {} }));
vi.mock('../lib/queue', () => ({ isQueueAvailable: () => false, addServerPatchJob: h.service }));
vi.mock('../lib/server-patch-lock', () => ({ acquireServerPatchLock: h.service, releaseServerPatchLock: h.service }));
vi.mock('../lib/server-auto-patch', () => ({
  AUTO_PATCH_SCHEDULES: ['off', 'daily', 'weekly'],
  AUTO_PATCH_WINDOW_MINUTES: 60,
  removeServerAutoPatchSchedule: h.service,
  syncServerAutoPatchSchedule: h.service,
  toAutoPatchSettings: h.service,
}));
vi.mock('../utils/ssh', () => ({ SSHClient: class {} }));
vi.mock('../lib/server-key-removal', () => ({ UNINSTALL_SCRIPT_URL: 'https://example.com/uninstall.sh' }));
vi.mock('../repositories/metrics.repository', () => ({ metricsRepository: serviceProxy() }));
vi.mock('../workers/scheduled-task.worker', () => ({ executeScheduledTask: h.service }));
vi.mock('../services/activity.service', () => ({ activityService: serviceProxy() }));
vi.mock('../services/project.service', () => ({ projectService: serviceProxy() }));
vi.mock('../services/project-transfer.service', () => ({ projectTransferService: serviceProxy() }));
vi.mock('../services/project-volume.service', () => ({ projectVolumeService: serviceProxy() }));
vi.mock('../services/project-worker.service', () => ({ projectWorkerService: serviceProxy() }));
vi.mock('../services/scheduled-task.service', () => ({ scheduledTaskService: serviceProxy() }));
vi.mock('../services/notification.service', () => ({ notificationService: serviceProxy() }));
vi.mock('../services/healthcheck.service', () => ({ healthCheckService: serviceProxy() }));
vi.mock('../services/envvar.service', () => ({ envVarService: serviceProxy() }));
vi.mock('../services/domain.service', () => ({ domainService: serviceProxy() }));
vi.mock('../services/server.service', () => ({ serverService: serviceProxy() }));
vi.mock('../services/database.service', () => ({ databaseService: serviceProxy() }));
vi.mock('../services/database-backup.service', () => ({ databaseBackupService: serviceProxy() }));
vi.mock('../services/database-import.service', () => ({ databaseImportService: serviceProxy() }));
vi.mock('../services/database-studio.service', () => ({ databaseStudioService: serviceProxy() }));
vi.mock('../services/nosql-studio.service', () => ({ nosqlStudioService: serviceProxy() }));

import { errorHandler } from '../middleware/error-handler';
import { t } from '../i18n';
import { API_KEY_SCOPES } from '../db/schema';
import { apiKeyScopesDescription } from '../config/openapi';
import { projectRoutes } from './projects';
import { projectVolumeRoutes } from './project-volumes';
import { projectWorkerRoutes } from './project-workers';
import { scheduledTaskRoutes } from './scheduled-tasks';
import { notificationRoutes } from './notifications';
import { healthCheckRoutes } from './healthchecks';
import { envVarRoutes } from './envvars';
import { domainRoutes } from './domains';
import { serverRoutes } from './servers';
import { databaseRoutes } from './databases';

// Same mount points and order as routes/index.ts
const app = new Hono();
app.route('/api/v1/projects', notificationRoutes);
app.route('/api/v1/projects', scheduledTaskRoutes);
app.route('/api/v1/projects', projectVolumeRoutes);
app.route('/api/v1/projects', projectWorkerRoutes);
app.route('/api/v1/projects', healthCheckRoutes);
app.route('/api/v1/projects', projectRoutes);
app.route('/api/v1/projects/:projectId/env', envVarRoutes);
app.route('/api/v1/projects/:projectId/domains', domainRoutes);
app.route('/api/v1/servers', serverRoutes);
app.route('/api/v1/databases', databaseRoutes);
app.onError((err, c) => errorHandler(err, c as Context));

const P = '00000000-0000-4000-8000-000000000001';
const X = '00000000-0000-4000-8000-0000000000a1';

const WRITE_SCOPES = ['projects', 'envvars', 'domains', 'servers', 'databases'].flatMap((r) => [`${r}:read`, `${r}:write`]);
const KEYS: Record<string, string> = {
  pk_live_write_only: WRITE_SCOPES.join(','),
  pk_live_with_delete: [...WRITE_SCOPES, 'projects:delete', 'envvars:delete', 'domains:delete', 'servers:delete', 'databases:delete'].join(','),
  pk_live_all: '*',
};
const SESSION = 'session-access-token';
const INSUFFICIENT_SCOPE = t('en', 'apiKeys', 'insufficientScope');

// Every DELETE route an API key can reach, with the delete scope it now needs
const DELETES: [string, string][] = [
  [`/projects/${P}`, 'projects:delete'],
  [`/projects/${P}/volumes/${X}`, 'projects:delete'],
  [`/projects/${P}/workers/${X}`, 'projects:delete'],
  [`/projects/${P}/scheduled-tasks/${X}`, 'projects:delete'],
  [`/projects/${P}/notifications/${X}`, 'projects:delete'],
  [`/projects/${P}/health-check`, 'projects:delete'],
  [`/projects/${P}/env/${X}`, 'envvars:delete'],
  [`/projects/${P}/domains/${X}`, 'domains:delete'],
  [`/servers/${X}`, 'servers:delete'],
  [`/servers/${X}/snapshots/${X}`, 'servers:delete'],
  [`/databases/${X}`, 'databases:delete'],
  [`/databases/connections/${X}`, 'databases:delete'],
  [`/databases/${X}/backups/${X}`, 'databases:delete'],
];

const call = (method: string, path: string, token: string, body?: unknown) =>
  app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  h.validate.mockReset().mockImplementation(async (token: string) =>
    token in KEYS ? { userId: 'user-1', organizationId: 'org-1', apiKey: { id: 'key-1', name: 'ci', scopes: KEYS[token] } } : null
  );
  h.verifyToken.mockReset().mockImplementation(async (token: string) => {
    if (token !== SESSION) throw new Error('invalid');
    return { type: 'access', sub: 'user-1', org: 'org-1' };
  });
  h.service.mockReset().mockResolvedValue({
    id: X,
    name: 'thing',
    domain: 'example.com',
    keyRemoval: null,
    containersCleanedUp: true,
    dns: null,
  });
});

describe('DELETE with a key that has :write but not :delete', () => {
  it.each(DELETES)('refuses DELETE %s (needs %s) and calls no service', async (path) => {
    const res = await call('DELETE', path, 'pk_live_write_only');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(INSUFFICIENT_SCOPE);
    expect(h.service).not.toHaveBeenCalled();
  });

  it('still creates and changes with :write', async () => {
    for (const [method, path, body] of [
      ['POST', `/projects/${P}/volumes`, { name: 'data', containerPath: '/data' }],
      ['POST', `/databases/${X}/start`, undefined],
      ['POST', `/servers/${X}/stop`, undefined],
    ] as const) {
      const res = await call(method, path, 'pk_live_write_only', body);
      expect(res.status, `${method} ${path}`).not.toBe(403);
      expect(h.service, `${method} ${path}`).toHaveBeenCalled();
      h.service.mockClear();
    }
  });
});

describe('DELETE with the delete scope', () => {
  it.each(DELETES)('allows DELETE %s with %s', async (path) => {
    const res = await call('DELETE', path, 'pk_live_with_delete');
    expect(res.status).toBe(200);
    expect(h.service).toHaveBeenCalled();
  });

  it.each(DELETES)('allows DELETE %s with a * key', async (path) => {
    expect((await call('DELETE', path, 'pk_live_all')).status).toBe(200);
  });

  it.each(DELETES)('leaves a dashboard session free to DELETE %s', async (path) => {
    expect((await call('DELETE', path, SESSION)).status).toBe(200);
  });
});

describe('scope list', () => {
  it('has a delete scope for every resource with a write scope', () => {
    for (const resource of ['projects', 'envvars', 'domains', 'servers', 'databases']) {
      expect(API_KEY_SCOPES).toHaveProperty(`${resource}:write`);
      expect(API_KEY_SCOPES).toHaveProperty(`${resource}:delete`);
    }
  });

  it('is listed in the OpenAPI security scheme', () => {
    const description = apiKeyScopesDescription();
    for (const scope of Object.keys(API_KEY_SCOPES)) {
      expect(description).toContain(`\`${scope}\``);
    }
  });
});

describe('migration 0097', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../db/migrations/0097_api_key_delete_scopes.sql', import.meta.url)),
    'utf8'
  );

  it('adds the delete scope to every key that has the matching write scope, once', () => {
    const statements = sql.split('--> statement-breakpoint');
    for (const resource of ['projects', 'envvars', 'domains', 'servers', 'databases']) {
      const statement = statements.find((s) => s.includes(`',${resource}:delete'`));
      expect(statement, resource).toBeDefined();
      expect(statement).toContain(`'${resource}:write' = ANY (`);
      expect(statement).toContain(`NOT ('${resource}:delete' = ANY (`);
    }
    // Data only: nothing is dropped or narrowed
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE FROM\b|\bALTER TABLE\b/);
    const journal = JSON.parse(
      readFileSync(fileURLToPath(new URL('../db/migrations/meta/_journal.json', import.meta.url)), 'utf8')
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.map((entry) => entry.tag)).toContain('0097_api_key_delete_scopes');
  });
});
