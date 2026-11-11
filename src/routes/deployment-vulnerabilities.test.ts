import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono, type Context } from 'hono';
import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

/**
 * GET /projects/:projectId/deployments/:deploymentId/vulnerabilities: the scan as JSON, or as a
 * CSV / JSON download; project access goes through the service, an API key needs deployments:read.
 */
const { h } = vi.hoisted(() => ({
  h: { getVulnerabilityScan: null as unknown as ReturnType<typeof import('vitest').vi.fn> },
}));

vi.mock('../middleware/auth', () => {
  const mw = async (c: Context, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('organizationId', 'org-1');
    c.set('locale', 'en');
    const scopes = c.req.header('x-test-key-scopes');
    if (scopes !== undefined) {
      c.set('isApiKeyAuth', true);
      c.set('apiKey', { id: 'key-1', scopes });
    }
    await next();
  };
  return { combinedAuthMiddleware: mw, authMiddleware: mw };
});
vi.mock('../services/apikey.service', () => ({
  hasScope: (keyScopes: string, required: string) => keyScopes === '*' || keyScopes.split(',').includes(required),
}));
vi.mock('../middleware/rate-limit', () => ({
  createDeploymentRateLimiter: () => async (_c: unknown, next: () => Promise<void>) => next(),
  createRateLimiter: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('../db', () => ({ db: {} }));
vi.mock('../services/activity.service', () => ({ activityService: {} }));
vi.mock('../services/deployment.service', () => ({
  deploymentService: { getVulnerabilityScan: (...args: unknown[]) => h.getVulnerabilityScan(...args) },
}));

const { deploymentRoutes } = await import('./deployments');
const { errorHandler } = await import('../middleware/error-handler');

const P = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';
const URL = `/api/v1/projects/${P}/deployments/${D}/vulnerabilities`;

const SCAN = {
  id: 'scan-1',
  deploymentId: D,
  projectId: P,
  status: 'completed',
  scanner: 'trivy',
  scannerVersion: '0.58.1',
  image: 'sha256:abc',
  criticalCount: 1,
  highCount: 0,
  mediumCount: 1,
  lowCount: 0,
  unknownCount: 0,
  vulnerabilities: [
    { id: 'CVE-2024-1', severity: 'CRITICAL', pkgName: 'openssl', installedVersion: '3.0.1', fixedVersion: '3.0.2', title: 'Bad, "very" bad', target: 'debian 12' },
    { id: 'CVE-2024-2', severity: 'MEDIUM', pkgName: 'lodash', installedVersion: '4.17.0', fixedVersion: null, title: '=cmd()', target: 'package-lock.json' },
  ],
  reason: null,
  scannedAt: new Date('2026-11-11T10:00:00Z'),
};

function app() {
  const a = new Hono();
  a.onError(errorHandler);
  a.route('/api/v1/projects/:projectId/deployments', deploymentRoutes);
  return a;
}

beforeEach(() => {
  h.getVulnerabilityScan = vi.fn(async () => SCAN);
});

describe('GET …/deployments/:deploymentId/vulnerabilities', () => {
  it('returns counts, total and the list, checking access through the service', async () => {
    const res = await app().request(URL);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      deploymentId: D,
      status: 'completed',
      scannerVersion: '0.58.1',
      counts: { critical: 1, high: 0, medium: 1, low: 0, unknown: 0 },
      total: 2,
      truncated: false,
    });
    expect((body.data.vulnerabilities as unknown[]).length).toBe(2);
    expect(h.getVulnerabilityScan).toHaveBeenCalledWith(D, P, 'org-1', 'user-1', 'en');
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('exports CSV with escaped, formula-safe fields', async () => {
    const res = await app().request(`${URL}?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="vulnerabilities-${D}.csv"`);
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines[0]).toBe('severity,vulnerability_id,package,installed_version,fixed_version,title,target');
    expect(lines[1]).toBe('CRITICAL,CVE-2024-1,openssl,3.0.1,3.0.2,"Bad, ""very"" bad",debian 12');
    expect(lines[2]).toBe("MEDIUM,CVE-2024-2,lodash,4.17.0,,'=cmd(),package-lock.json");
  });

  it('exports JSON as a download', async () => {
    const res = await app().request(`${URL}?format=json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="vulnerabilities-${D}.json"`);
    expect(((await res.json()) as { data: { total: number } }).data.total).toBe(2);
  });

  it('rejects an unknown format', async () => {
    const res = await app().request(`${URL}?format=xml`);
    expect(res.status).toBe(400);
    expect(h.getVulnerabilityScan).not.toHaveBeenCalled();
  });

  it('passes the service 404 through (no scan, or no access to the project)', async () => {
    h.getVulnerabilityScan = vi.fn(async () => {
      throw new HTTPException(404, { message: 'This deployment has no vulnerability scan', cause: { code: 'NO_VULNERABILITY_SCAN' } });
    });
    const res = await app().request(URL);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).toContain('NO_VULNERABILITY_SCAN');
  });

  it('needs deployments:read on an API key', async () => {
    const denied = await app().request(URL, { headers: { 'x-test-key-scopes': 'projects:read' } });
    expect(denied.status).toBe(403);
    expect(h.getVulnerabilityScan).not.toHaveBeenCalled();

    const allowed = await app().request(URL, { headers: { 'x-test-key-scopes': 'deployments:read' } });
    expect(allowed.status).toBe(200);
  });

  it('is in the OpenAPI document with the format query and both content types', () => {
    const docApp = new OpenAPIHono();
    docApp.route('/api/v1/projects/{projectId}/deployments', deploymentRoutes);
    const doc = docApp.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '0' } });
    const op = doc.paths?.['/api/v1/projects/{projectId}/deployments/{deploymentId}/vulnerabilities']?.get;
    expect(op).toBeDefined();
    expect(op?.parameters?.some((p) => 'name' in p && p.name === 'format')).toBe(true);
    const content = (op?.responses?.['200'] as { content?: Record<string, unknown> }).content ?? {};
    expect(Object.keys(content).sort()).toEqual(['application/json', 'text/csv']);
    expect(doc.components?.schemas?.DeploymentVulnerabilityScan).toBeDefined();
  });
});
