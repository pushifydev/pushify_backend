import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono, type Context } from 'hono';

/**
 * POST /projects/:projectId/previews/:previewId/redeploy | close: members and up redeploy an open
 * preview from the head of its PR branch or close it with the PR-closed teardown, viewers get 403,
 * an API key needs projects:write, a closed preview answers 409, and each action is audited.
 *
 * The real auth middleware, scope check, role check (requireProjectMember), routes and preview
 * service run; the JWT check, membership, repositories, queue, SSH and the audit log are mocked.
 */
const { h } = vi.hoisted(() => ({
  h: {
    roles: {} as Record<string, string>,
    project: null as Record<string, unknown> | null,
    previews: new Map<string, Record<string, unknown>>(),
    deployments: [] as Array<Record<string, unknown>>,
    scheduled: [] as string[],
    teardown: [] as string[],
    audit: [] as Array<Record<string, unknown>>,
  },
}));

const PROJECT_ID = '00000000-0000-4000-8000-0000000000a1';
const PREVIEW_ID = '00000000-0000-4000-8000-0000000000b1';

const KEYS: Record<string, { userId: string; scopes: string }> = {
  pk_live_member_read: { userId: 'u-member', scopes: 'projects:read' },
  pk_live_member_write: { userId: 'u-member', scopes: 'projects:read,projects:write' },
};

vi.mock('../db', () => ({
  // requireProjectMember: the project row, when it is the organization's
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (h.project && h.project.organizationId === 'org-1' ? [h.project] : []) }),
      }),
    }),
  },
}));
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
vi.mock('../repositories/project.repository', () => ({
  projectRepository: { findById: async () => h.project },
}));
vi.mock('../repositories/preview.repository', () => {
  const byPr = (pr: number) => [...h.previews.values()].find((p) => p.prNumber === pr);
  return {
    previewRepository: {
      findById: async (id: string) => h.previews.get(id),
      findByProjectAndPr: async (_p: string, pr: number) => byPr(pr),
      update: async (id: string, patch: Record<string, unknown>) => Object.assign(h.previews.get(id)!, patch),
      close: async (id: string) => Object.assign(h.previews.get(id)!, { status: 'stopped', closedAt: new Date() }),
      updateByProjectAndPr: async () => undefined,
    },
  };
});
vi.mock('../repositories/deployment.repository', () => ({
  deploymentRepository: {
    create: async (row: Record<string, unknown>) => {
      const d = { id: `dep-${h.deployments.length + 1}`, ...row };
      h.deployments.push(d);
      return d;
    },
  },
}));
vi.mock('../lib/deployment-scheduler', () => ({
  scheduleDeploymentProcessing: async (deploymentId: string) => {
    h.scheduled.push(deploymentId);
  },
}));
vi.mock('../services/organization-billing.service', () => ({
  canOrganizationDeploy: async () => true,
  assertOrganizationCanMutateResources: async () => {},
}));
vi.mock('../services/plan-limits.service', () => ({
  planLimitsService: {
    assertPreviewDeploymentsAllowed: async () => {},
    assertDeploymentsQuota: async () => {},
    assertBuildMinutesQuota: async () => {},
  },
}));
vi.mock('../services/git-provider-access.service', () => ({ getProjectGitAccessToken: async () => null }));
vi.mock('../services/github.service', () => ({ githubService: {} }));
vi.mock('../services/gitlab.service', () => ({ gitlabService: {} }));
vi.mock('../lib/encryption', () => ({ decrypt: (v: string) => v }));
vi.mock('../workers/docker', () => ({ stopContainer: async () => {}, removeContainer: async () => {} }));
vi.mock('../workers/port-manager', () => ({ releasePort: async () => {} }));
vi.mock('../workers/remote-deployment', () => ({ closeFirewallPort: async () => {} }));
vi.mock('../lib/cloudflare-dns', () => ({ deleteAutoSubdomainRecordQuietly: async () => {}, hostnameOf: () => null }));
vi.mock('../utils/ssh', () => ({
  getSSHConnection: async () => ({
    exec: async (script: string) => {
      h.teardown.push(script);
      return { stdout: '', stderr: '', code: 0 };
    },
    disconnect: () => {},
  }),
}));
vi.mock('../lib/project-remote-cleanup', () => ({
  resolveDeployServerForCleanup: async () => ({ id: 'srv-1', ipv4: '203.0.113.5', sshPrivateKey: 'key' }),
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
import { previewRoutes } from './previews';

const app = new Hono();
app.route('/api/v1/projects', previewRoutes);
app.onError((err, c) => errorHandler(err, c as Context));

const act = (action: 'redeploy' | 'close', token: string, previewId = PREVIEW_ID) =>
  app.request(`/api/v1/projects/${PROJECT_ID}/previews/${previewId}/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.7' },
  });

async function errorOf(res: Response) {
  return ((await res.json()) as { error: { code?: string; message: string } }).error;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.roles = { 'u-owner': 'owner', 'u-admin': 'admin', 'u-member': 'member', 'u-viewer': 'viewer' };
  // A git project built by the static buildpack (nginx image), previews on
  h.project = {
    id: PROJECT_ID,
    slug: 'shop',
    organizationId: 'org-1',
    serverId: 'srv-1',
    framework: 'static',
    outputDirectory: 'dist',
    gitRepoUrl: 'https://github.com/acme/shop',
    settings: { previewDeploymentsEnabled: true },
  };
  h.previews = new Map([
    [
      PREVIEW_ID,
      {
        id: PREVIEW_ID,
        projectId: PROJECT_ID,
        deploymentId: 'dep-0',
        prNumber: 42,
        prTitle: 'Add pricing page',
        prBranch: 'feature/pricing',
        baseBranch: 'main',
        previewUrl: 'https://pr-42-shop.preview.example.com',
        containerName: 'pushify-preview-shop-pr-42',
        hostPort: 3142,
        githubCommentId: null,
        status: 'running',
        closedAt: null,
      },
    ],
  ]);
  h.deployments = [];
  h.scheduled = [];
  h.teardown = [];
  h.audit = [];
});

describe('POST …/previews/:previewId/redeploy', () => {
  it.each(['owner', 'admin', 'member'])('a %s redeploys the PR branch head of a static-buildpack preview, audited', async (role) => {
    const res = await act('redeploy', `session-${role}`);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown>; message: string };
    expect(body.message).toBe(t('en', 'previews', 'redeployStarted'));
    expect(body.data).toMatchObject({ id: PREVIEW_ID, deploymentId: 'dep-1', status: 'pending', prNumber: 42 });

    expect(h.deployments).toHaveLength(1);
    expect(h.deployments[0]).toMatchObject({
      projectId: PROJECT_ID,
      branch: 'feature/pricing',
      isPreview: true,
      previewPrNumber: 42,
      trigger: 'redeploy',
      triggeredById: `u-${role}`,
    });
    expect(h.deployments[0].commitHash).toBeUndefined();
    expect(h.scheduled).toEqual(['dep-1']);

    expect(h.audit).toEqual([
      expect.objectContaining({
        organizationId: 'org-1',
        userId: `u-${role}`,
        projectId: PROJECT_ID,
        action: 'preview.redeployed',
        metadata: { previewId: PREVIEW_ID, prNumber: 42, deploymentId: 'dep-1' },
        ipAddress: '203.0.113.7',
        source: 'ui',
      }),
    ]);
  });

  it('a viewer gets 403 and nothing is queued or audited', async () => {
    const res = await act('redeploy', 'session-viewer');
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toBe(t('en', 'errors', 'forbidden'));
    expect(h.deployments).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('a closed preview answers 409', async () => {
    Object.assign(h.previews.get(PREVIEW_ID)!, { status: 'stopped', closedAt: new Date() });
    const res = await act('redeploy', 'session-member');
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'CONFLICT', message: t('en', 'previews', 'alreadyClosed') });
    expect(h.deployments).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('an API key needs projects:write', async () => {
    const res = await act('redeploy', 'pk_live_member_read');
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toBe(t('en', 'apiKeys', 'insufficientScope'));
    expect(h.deployments).toEqual([]);

    const ok = await act('redeploy', 'pk_live_member_write');
    expect(ok.status).toBe(201);
    expect(h.audit[0]).toMatchObject({ action: 'preview.redeployed', userId: 'u-member', source: 'api' });
  });

  it('404 for a preview that is not this project’s', async () => {
    h.previews.get(PREVIEW_ID)!.projectId = '00000000-0000-4000-8000-0000000000a2';
    const res = await act('redeploy', 'session-member');
    expect(res.status).toBe(404);
    expect((await errorOf(res)).message).toBe(t('en', 'previews', 'notFound'));
  });
});

describe('POST …/previews/:previewId/close', () => {
  it.each(['owner', 'admin', 'member'])('a %s closes the preview with the PR-closed teardown, audited', async (role) => {
    const res = await act('close', `session-${role}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>; message: string };
    expect(body.message).toBe(t('en', 'previews', 'closed'));
    expect(body.data).toMatchObject({ id: PREVIEW_ID, status: 'stopped' });
    expect(body.data.closedAt).toBeTruthy();

    // Only the PR's containers / image / vhost; production (`pushify-shop`) is never named
    expect(h.teardown).toHaveLength(1);
    expect(h.teardown[0]).toContain('pushify-shop-pr-42');
    for (const m of h.teardown[0].match(/shop[^'\s;$|]*/g) ?? []) expect(m.startsWith('shop-pr-42')).toBe(true);
    expect(h.deployments).toEqual([]);

    expect(h.audit).toEqual([
      expect.objectContaining({
        organizationId: 'org-1',
        userId: `u-${role}`,
        projectId: PROJECT_ID,
        action: 'preview.closed',
        metadata: { previewId: PREVIEW_ID, prNumber: 42 },
        source: 'ui',
      }),
    ]);
  });

  it('a viewer gets 403 and nothing is torn down', async () => {
    const res = await act('close', 'session-viewer');
    expect(res.status).toBe(403);
    expect(h.teardown).toEqual([]);
    expect(h.previews.get(PREVIEW_ID)!.closedAt).toBeNull();
    expect(h.audit).toEqual([]);
  });

  it('closing twice: the second answers 409 and nothing more is torn down', async () => {
    expect((await act('close', 'session-member')).status).toBe(200);
    const res = await act('close', 'session-member');
    expect(res.status).toBe(409);
    expect(h.teardown).toHaveLength(1);
    expect(h.audit).toHaveLength(1);
    // …and a closed preview cannot be redeployed
    expect((await act('redeploy', 'session-member')).status).toBe(409);
  });

  it('someone outside the organization gets 403', async () => {
    delete h.roles['u-member'];
    expect((await act('close', 'session-member')).status).toBe(403);
    expect(h.teardown).toEqual([]);
  });
});
