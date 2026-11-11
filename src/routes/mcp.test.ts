import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * The read-only MCP endpoint goes through the real apiKeyAuthMiddleware (2FA policy, the key's
 * project list, the plan rate limit) and the real tool layer (scopes, output fields, masking).
 * Only key validation, the 2FA lookups, the rate limiter, the services behind the tools and the
 * project's log masker source are mocked, so nothing touches a database.
 */
const { h } = vi.hoisted(() => ({
  h: {
    validate: vi.fn(),
    rateLimit: vi.fn(),
    twoFactorRequired: false,
    getByOrganization: vi.fn(),
    getById: vi.fn(),
    getByProject: vi.fn(),
    getLogs: vi.fn(),
    listServers: vi.fn(),
    getMasker: vi.fn(),
    keyProjectsSeenByService: [] as unknown[],
  },
}));

vi.mock('../services/apikey.service', () => ({
  apiKeyService: { validate: h.validate },
  hasScope: (keyScopes: string, required: string) => {
    if (keyScopes === '*') return true;
    const scopes = keyScopes.split(',').map((s) => s.trim());
    return scopes.includes(required) || scopes.includes('*');
  },
}));
vi.mock('../lib/org-two-factor', () => ({
  isOrganizationTwoFactorRequired: async () => h.twoFactorRequired,
  userHasTwoFactorEnabled: async () => false,
  recordOrgTwoFactorDenial: async () => {},
  orgTwoFactorRequiredError: () =>
    new HTTPException(403, { message: '2FA required', cause: { code: 'ORG_2FA_REQUIRED' } }),
}));
vi.mock('../middleware/rate-limit', () => ({ applyPlanApiRateLimit: h.rateLimit }));
vi.mock('../services/project.service', () => ({
  projectService: { getByOrganization: h.getByOrganization, getById: h.getById },
}));
vi.mock('../services/deployment.service', () => ({
  deploymentService: { getByProject: h.getByProject, getLogs: h.getLogs },
}));
vi.mock('../services/server.service', () => ({ serverService: { listServers: h.listServers } }));
vi.mock('../workers/log-collector', () => ({ getProjectLogMasker: h.getMasker }));

import { mcpRoutes } from './mcp';
import { errorHandler } from '../middleware/error-handler';
import { createLogMasker } from '../lib/log-masking';
import { currentApiKeyProjectIds } from '../lib/api-key-project-scope';
import { tailLogLines } from '../services/mcp.service';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const DEP = '33333333-3333-4333-8333-333333333333';
const SECRET = 'sk_live_Zt9QwErTyUiOp1234567890';
const WEBHOOK_SECRET = 'whsec_0123456789abcdef0123456789abcdef';

const app = new Hono();
app.onError(errorHandler);
app.route('/api/v1/mcp', mcpRoutes);

function keyWith(scopes: string, projectIds: string[] | null = null) {
  h.validate.mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    apiKey: { id: 'key-1', name: 'claude', scopes, projectIds },
  });
}

let nextId = 1;
async function rpc(method: string, params?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request('/api/v1/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer pk_live_test',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = await rpc('tools/call', { name, arguments: args });
  expect(res.status).toBe(200);
  const result = res.body.result as { content: Array<{ text: string }>; isError?: boolean };
  const text = result.content.map((c) => c.text).join('\n');
  // Parsed tool output; the tests read nested fields of it directly
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* error results are plain text */
  }
  return { isError: !!result.isError, text, data, raw: res.raw };
}

function project(id: string, name: string) {
  return {
    id,
    organizationId: 'org-1',
    name,
    slug: name.toLowerCase(),
    status: 'active',
    gitBranch: 'main',
    serverId: 'srv-1',
    webhookSecret: WEBHOOK_SECRET,
    settings: { productionUrl: `https://${name.toLowerCase()}.example.com`, apiToken: SECRET },
    autoDeploy: true,
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    domains: [{ id: 'd1', domain: `${name.toLowerCase()}.example.com`, isPrimary: true, sslStatus: 'active' }],
    server: { id: 'srv-1', name: 'web-1', ipv4: '10.0.0.1', status: 'running', setupStatus: 'completed', sshPrivateKey: SECRET },
  };
}

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    id: DEP,
    projectId: A,
    status: 'failed',
    trigger: 'git_push',
    environment: 'production',
    branch: 'main',
    commitHash: 'abc123',
    commitMessage: 'fix things',
    errorMessage: `Build failed: could not connect with password ${SECRET}`,
    failureCategory: 'build',
    failureSummary: `Error: auth failed for ${SECRET}`,
    buildLogs: `leaked ${SECRET}`,
    runSpecEncrypted: 'encrypted-run-spec',
    createdAt: new Date('2026-11-02T00:00:00Z'),
    buildStartedAt: null,
    buildFinishedAt: null,
    deployFinishedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.twoFactorRequired = false;
  h.keyProjectsSeenByService = [];
  h.rateLimit.mockImplementation(async (_c: unknown, next: () => Promise<void>) => next());
  h.getMasker.mockImplementation(async () => createLogMasker({ STRIPE_SECRET_KEY: SECRET }));
  h.getByOrganization.mockImplementation(async () => {
    h.keyProjectsSeenByService.push(currentApiKeyProjectIds());
    return [project(A, 'Alpha'), project(B, 'Beta')];
  });
  h.getById.mockImplementation(async (id: string) => project(id, id === A ? 'Alpha' : 'Beta'));
  h.getByProject.mockImplementation(async () => [deployment()]);
  h.getLogs.mockResolvedValue({
    logs: ['line 1', 'line 2', `export STRIPE_SECRET_KEY=${SECRET}`, 'line 4', ''].join('\n'),
    status: 'failed',
  });
  h.listServers.mockResolvedValue([
    {
      id: 'srv-1',
      name: 'web-1',
      provider: 'hetzner',
      region: 'nbg1',
      size: 'sm',
      status: 'running',
      setupStatus: 'completed',
      statusMessage: null,
      ipv4: '10.0.0.1',
      privateIp: '10.1.0.1',
      providerId: 'hz-123',
      labels: { owner: 'ops' },
      vcpus: 2,
      memoryMb: 4096,
      diskGb: 40,
      diskUsedPercent: 71,
      diskCheckedAt: new Date('2026-11-10T00:00:00Z'),
      projectCount: 2,
      databaseCount: 0,
      lastSeenAt: null,
    },
  ]);
});

describe('MCP transport', () => {
  beforeEach(() => keyWith('*'));

  it('initializes with a supported protocol version and the tools capability', async () => {
    const res = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'claude-code', version: '1.0.0' },
    });
    expect(res.status).toBe(200);
    expect(res.body.result.protocolVersion).toBe('2025-06-18');
    expect(res.body.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(res.body.result.serverInfo.name).toBe('pushify');

    const unknown = await rpc('initialize', { protocolVersion: '1999-01-01' });
    expect(unknown.body.result.protocolVersion).toBe('2025-11-25');
  });

  it('lists exactly the five read-only tools', async () => {
    const res = await rpc('tools/list');
    const tools = res.body.result.tools as Array<{
      name: string;
      annotations: { readOnlyHint: boolean };
      inputSchema: { type: string; required: string[]; properties: Record<string, unknown> };
    }>;
    expect(tools.map((t) => t.name)).toEqual([
      'list_projects',
      'get_project',
      'list_deployments',
      'get_deployment_logs',
      'list_servers',
    ]);
    expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    const logs = tools.find((t) => t.name === 'get_deployment_logs')!;
    expect(logs.inputSchema.type).toBe('object');
    expect(logs.inputSchema.required).toEqual(['projectId', 'deploymentId']);
    expect(Object.keys(logs.inputSchema.properties)).toEqual(['projectId', 'deploymentId', 'type', 'lines']);
  });

  it('accepts notifications without an answer and answers ping', async () => {
    const res = await app.request('/api/v1/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer pk_live_test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.status).toBe(202);
    expect((await rpc('ping')).body.result).toEqual({});
  });

  it('answers protocol errors for unknown methods, unknown tools, batches and bad JSON', async () => {
    expect((await rpc('resources/list')).body.error.code).toBe(-32601);
    expect((await rpc('tools/call', { name: 'deploy_project', arguments: {} })).body.error.code).toBe(-32602);

    const batch = await app.request('/api/v1/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer pk_live_test', 'Content-Type': 'application/json' },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
    });
    expect(batch.status).toBe(400);

    const bad = await app.request('/api/v1/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer pk_live_test', 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe(-32700);
  });

  it('has no server stream or session: GET and DELETE are 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await app.request('/api/v1/mcp', { method, headers: { Authorization: 'Bearer pk_live_test' } });
      expect(res.status, method).toBe(405);
    }
  });

  it('refuses a foreign Origin and an unsupported protocol version header', async () => {
    expect((await rpc('ping', undefined, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await rpc('ping', undefined, { 'MCP-Protocol-Version': '1999-01-01' })).status).toBe(400);
    expect((await rpc('ping', undefined, { 'MCP-Protocol-Version': '2025-06-18' })).status).toBe(200);
  });
});

describe('MCP authentication', () => {
  it('requires an API key: no token and a session token are 401', async () => {
    keyWith('*');
    const none = await app.request('/api/v1/mcp', { method: 'POST', body: '{}' });
    expect(none.status).toBe(401);
    const jwt = await rpc('ping', undefined, { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x' });
    expect(jwt.status).toBe(401);
    expect(h.validate).not.toHaveBeenCalled();
  });

  it('refuses an unknown or revoked key', async () => {
    h.validate.mockResolvedValue(null);
    expect((await rpc('tools/list')).status).toBe(401);
  });

  it('applies the organization 2FA policy before any tool runs', async () => {
    keyWith('*');
    h.twoFactorRequired = true;
    const res = await rpc('tools/call', { name: 'list_projects', arguments: {} });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORG_2FA_REQUIRED');
    expect(h.getByOrganization).not.toHaveBeenCalled();
  });

  it('counts every message against the plan rate limit, and stops at it', async () => {
    keyWith('*');
    await rpc('tools/list');
    expect(h.rateLimit).toHaveBeenCalledTimes(1);

    h.rateLimit.mockImplementation(async () => {
      throw new HTTPException(429, { message: 'Too many requests' });
    });
    const res = await rpc('tools/call', { name: 'list_projects', arguments: {} });
    expect(res.status).toBe(429);
    expect(h.getByOrganization).not.toHaveBeenCalled();
  });
});

describe('MCP tool scopes', () => {
  it('a key without the scope cannot call the tool', async () => {
    keyWith('servers:read');
    for (const [name, args] of [
      ['list_projects', {}],
      ['get_project', { projectId: A }],
      ['list_deployments', { projectId: A }],
      ['get_deployment_logs', { projectId: A, deploymentId: DEP }],
    ] as const) {
      const res = await callTool(name, args);
      expect(res.isError, name).toBe(true);
      expect(res.text, name).toContain('API key does not have required permissions');
    }
    keyWith('projects:read');
    expect((await callTool('list_servers')).isError).toBe(true);

    expect(h.getByOrganization).not.toHaveBeenCalled();
    expect(h.getById).not.toHaveBeenCalled();
    expect(h.getByProject).not.toHaveBeenCalled();
    expect(h.getLogs).not.toHaveBeenCalled();
    expect(h.listServers).not.toHaveBeenCalled();
  });

  it('logs:read alone is enough for the logs tool, as on the REST route', async () => {
    keyWith('logs:read');
    expect((await callTool('get_deployment_logs', { projectId: A, deploymentId: DEP })).isError).toBe(false);
  });

  it('get_project leaves out the latest deployment without deployments:read', async () => {
    keyWith('projects:read');
    const res = await callTool('get_project', { projectId: A });
    expect(res.isError).toBe(false);
    expect(res.data).not.toHaveProperty('latestDeployment');
    expect(h.getByProject).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments without calling the service', async () => {
    keyWith('*');
    const res = await callTool('get_deployment_logs', { projectId: 'nope', deploymentId: DEP, lines: 5000 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('projectId');
    expect(res.text).toContain('lines');
    expect(h.getLogs).not.toHaveBeenCalled();
  });

  it('returns a service refusal (e.g. 404) as an error result', async () => {
    keyWith('*');
    h.getById.mockRejectedValue(new HTTPException(404, { message: 'Project not found' }));
    const res = await callTool('get_project', { projectId: A });
    expect(res).toMatchObject({ isError: true, text: 'Project not found' });
  });
});

describe('a key limited to projects', () => {
  beforeEach(() => keyWith('*', [A]));

  it('lists only its own projects, and the services see its list', async () => {
    const res = await callTool('list_projects');
    expect(res.data.projects.map((p: { id: string }) => p.id)).toEqual([A]);
    expect(h.keyProjectsSeenByService).toEqual([[A]]);
  });

  it('cannot see another project through any project tool', async () => {
    for (const [name, args] of [
      ['get_project', { projectId: B }],
      ['list_deployments', { projectId: B }],
      ['get_deployment_logs', { projectId: B, deploymentId: DEP }],
    ] as const) {
      const res = await callTool(name, args);
      expect(res.isError, name).toBe(true);
      expect(res.text, name).toBe('Project not found');
    }
    expect(h.getById).not.toHaveBeenCalled();
    expect(h.getByProject).not.toHaveBeenCalled();
    expect(h.getLogs).not.toHaveBeenCalled();
  });

  it('reaches its own project', async () => {
    const res = await callTool('get_project', { projectId: A });
    expect(res.isError).toBe(false);
    expect(res.data.id).toBe(A);
  });

  it('cannot list the organization\'s servers', async () => {
    const res = await callTool('list_servers');
    expect(res.isError).toBe(true);
    expect(res.text).toContain('limited to specific projects');
    expect(h.listServers).not.toHaveBeenCalled();
  });
});

describe('MCP tool output', () => {
  beforeEach(() => keyWith('*'));

  it('never contains env values or secrets from any tool', async () => {
    const outputs = [
      await callTool('list_projects'),
      await callTool('get_project', { projectId: A }),
      await callTool('list_deployments', { projectId: A }),
      await callTool('get_deployment_logs', { projectId: A, deploymentId: DEP }),
      await callTool('list_servers'),
    ];
    for (const out of outputs) {
      expect(out.isError).toBe(false);
      expect(out.raw).not.toContain(SECRET);
      expect(out.raw).not.toContain(WEBHOOK_SECRET);
      expect(out.raw).not.toContain('encrypted-run-spec');
      expect(out.raw).not.toContain('webhookSecret');
      expect(out.raw).not.toContain('settings');
    }
  });

  it('get_project returns status, domains, server and the latest deployment (masked)', async () => {
    const { data } = await callTool('get_project', { projectId: A });
    expect(data).toMatchObject({
      id: A,
      status: 'active',
      primaryDomain: 'alpha.example.com',
      productionUrl: 'https://alpha.example.com',
      server: { id: 'srv-1', name: 'web-1', status: 'running', setupStatus: 'completed' },
      domains: [{ domain: 'alpha.example.com', isPrimary: true, sslStatus: 'active' }],
      latestDeployment: { id: DEP, status: 'failed', failureCategory: 'build' },
    });
    expect(data.latestDeployment.errorMessage).toContain('••••••');
    expect(h.getByProject).toHaveBeenCalledWith(A, 'org-1', 'user-1', 'en', 1, 0);
  });

  it('list_deployments passes the limit to the service', async () => {
    await callTool('list_deployments', { projectId: A, limit: 3 });
    expect(h.getByProject).toHaveBeenCalledWith(A, 'org-1', 'user-1', 'en', 3, 0);
  });

  it('get_deployment_logs returns the last N lines with secrets masked', async () => {
    const { data } = await callTool('get_deployment_logs', { projectId: A, deploymentId: DEP, type: 'deploy', lines: 2 });
    expect(h.getLogs).toHaveBeenCalledWith(DEP, A, 'org-1', 'user-1', 'en', 'deploy');
    expect(data).toEqual({
      deploymentId: DEP,
      type: 'deploy',
      status: 'failed',
      totalLines: 4,
      returnedLines: 2,
      truncated: true,
      logs: 'export STRIPE_SECRET_KEY=••••••\nline 4',
    });
  });

  it('get_deployment_logs returns nothing when the masker cannot be built', async () => {
    h.getMasker.mockRejectedValue(new Error('secret provider down'));
    const res = await callTool('get_deployment_logs', { projectId: A, deploymentId: DEP });
    expect(res.isError).toBe(true);
    expect(res.raw).not.toContain('line 1');
    expect(res.raw).not.toContain(SECRET);
  });

  it('list_servers returns status and disk, not provider internals', async () => {
    const { data } = await callTool('list_servers');
    expect(data.servers[0]).toMatchObject({ id: 'srv-1', status: 'running', diskGb: 40, diskUsedPercent: 71 });
    expect(data.servers[0]).not.toHaveProperty('privateIp');
    expect(data.servers[0]).not.toHaveProperty('providerId');
    expect(data.servers[0]).not.toHaveProperty('labels');
  });
});

describe('tailLogLines', () => {
  it('returns the last lines and counts them', () => {
    expect(tailLogLines('a\nb\nc\n', 2)).toEqual({ text: 'b\nc', totalLines: 3, returnedLines: 2 });
    expect(tailLogLines(null, 10)).toEqual({ text: '', totalLines: 0, returnedLines: 0 });
  });

  it('caps very long output at a line start', () => {
    const long = `${'x'.repeat(60_000)}\n${'y'.repeat(60_000)}\nlast`;
    const tail = tailLogLines(long, 10);
    expect(tail.text.startsWith('y')).toBe(true);
    expect(tail.text.endsWith('last')).toBe(true);
    expect(tail.returnedLines).toBe(2);
  });
});
