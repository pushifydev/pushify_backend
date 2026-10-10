import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  previews: new Map<number, Record<string, unknown>>(),
  deploymentCreate: vi.fn(),
  schedule: vi.fn(),
  teardownExec: vi.fn(),
  stopContainer: vi.fn(),
  removeContainer: vi.fn(),
  server: null as Record<string, unknown> | null,
}));

vi.mock('../repositories/project.repository', () => ({
  projectRepository: { findById: async () => h.project },
}));
vi.mock('../repositories/deployment.repository', () => ({
  deploymentRepository: { create: h.deploymentCreate },
}));
vi.mock('../repositories/preview.repository', () => ({
  previewRepository: {
    findByProjectAndPr: async (_p: string, pr: number) => h.previews.get(pr),
    create: async (row: Record<string, unknown>) => {
      const p = { id: `pv-${row.prNumber}`, githubCommentId: null, hostPort: null, ...row };
      h.previews.set(row.prNumber as number, p);
      return p;
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      for (const p of h.previews.values()) if (p.id === id) Object.assign(p, patch);
      return [...h.previews.values()].find((p) => p.id === id);
    },
    close: async (id: string) => {
      for (const p of h.previews.values()) if (p.id === id) Object.assign(p, { status: 'stopped' });
    },
    updateByProjectAndPr: vi.fn(),
  },
}));
vi.mock('../repositories/organization.repository', () => ({ organizationRepository: {} }));
vi.mock('./organization-billing.service', () => ({ canOrganizationDeploy: async () => true }));
vi.mock('./plan-limits.service', () => ({
  planLimitsService: {
    assertPreviewDeploymentsAllowed: async () => {},
    assertDeploymentsQuota: async () => {},
    assertBuildMinutesQuota: async () => {},
  },
}));
vi.mock('./git-provider-access.service', () => ({ getProjectGitAccessToken: async () => null }));
vi.mock('./github.service', () => ({ githubService: {} }));
vi.mock('./gitlab.service', () => ({ gitlabService: {} }));
vi.mock('../lib/deployment-scheduler', () => ({ scheduleDeploymentProcessing: h.schedule }));
vi.mock('../lib/org-access', () => ({ requireProjectMember: async () => {} }));
vi.mock('../lib/encryption', () => ({ decrypt: (v: string) => v }));
vi.mock('../workers/docker', () => ({ stopContainer: h.stopContainer, removeContainer: h.removeContainer }));
vi.mock('../workers/port-manager', () => ({ releasePort: async () => {} }));
vi.mock('../workers/remote-deployment', () => ({ closeFirewallPort: async () => {} }));
vi.mock('../lib/cloudflare-dns', () => ({
  deleteAutoSubdomainRecordQuietly: async () => {},
  hostnameOf: () => null,
}));
vi.mock('../utils/ssh', () => ({
  getSSHConnection: async () => ({ exec: h.teardownExec, disconnect: () => {} }),
}));
vi.mock('../lib/project-remote-cleanup', () => ({
  resolveDeployServerForCleanup: async () => h.server,
}));

import { previewService, isPublishedStaticSite } from './preview.service';

const PROJECT_ID = 'proj-1';

/** The kinds of project a PR can open against. */
const projects = {
  // Git repo, built by the static buildpack / a Vite-style framework into an nginx image.
  gitStatic: { framework: 'static', outputDirectory: 'dist', settings: { previewDeploymentsEnabled: true } },
  // Git repo, an app server in a container.
  container: { framework: 'nodejs', outputDirectory: null, settings: { previewDeploymentsEnabled: true } },
};

function setProject(extra: Record<string, unknown>) {
  h.project = {
    id: PROJECT_ID,
    slug: 'shop',
    organizationId: 'org-1',
    serverId: 'srv-1',
    gitRepoUrl: 'https://github.com/acme/shop',
    ...extra,
  };
}

beforeEach(() => {
  h.previews.clear();
  h.deploymentCreate.mockReset().mockImplementation(async (row: Record<string, unknown>) => ({ id: 'dep-1', ...row }));
  h.schedule.mockReset().mockResolvedValue(undefined);
  h.teardownExec.mockReset().mockResolvedValue({ stdout: '', stderr: '', code: 0 });
  h.stopContainer.mockReset();
  h.removeContainer.mockReset();
  h.server = { id: 'srv-1', ipv4: '203.0.113.5', sshPrivateKey: 'key' };
});

describe.each(Object.entries(projects))('PR preview lifecycle — %s project', (_kind, project) => {
  beforeEach(() => setProject(project));

  it('is enabled when the project turned previews on', async () => {
    expect(await previewService.isPreviewEnabled(PROJECT_ID)).toBe(true);
  });

  it('PR opened → queues a preview deployment of the PR branch and records the preview', async () => {
    const preview = await previewService.createOrUpdatePreview(PROJECT_ID, {
      prNumber: 7,
      prTitle: 'Tweak',
      prBranch: 'feature/x',
      baseBranch: 'main',
      commitHash: 'abc',
    });

    expect(h.deploymentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, branch: 'feature/x', isPreview: true, previewPrNumber: 7 })
    );
    expect(h.schedule).toHaveBeenCalledWith('dep-1', PROJECT_ID);
    expect(preview).toMatchObject({ prNumber: 7, status: 'pending', containerName: 'pushify-preview-shop-pr-7' });
  });

  it('deploy finished → running with the URL the deployer reported', async () => {
    await previewService.createOrUpdatePreview(PROJECT_ID, {
      prNumber: 7, prBranch: 'feature/x', baseBranch: 'main', commitHash: 'abc',
    });
    await previewService.updatePreviewStatus(PROJECT_ID, 7, 'running', 41007, 'http://203.0.113.5:41007');
    expect(h.previews.get(7)).toMatchObject({ status: 'running', hostPort: 41007, previewUrl: 'http://203.0.113.5:41007' });
  });

  it('PR closed → tears down the preview on its server and closes the record', async () => {
    await previewService.createOrUpdatePreview(PROJECT_ID, {
      prNumber: 7, prBranch: 'feature/x', baseBranch: 'main', commitHash: 'abc',
    });
    await previewService.cleanupPreview(PROJECT_ID, 7);

    expect(h.teardownExec).toHaveBeenCalledTimes(1);
    const script = h.teardownExec.mock.calls[0][0] as string;
    expect(script).toContain('pushify-shop-pr-7');
    expect(script).toContain('/etc/nginx/sites-enabled/pushify-shop-pr-7');
    expect(h.previews.get(7)?.status).toBe('stopped');
  });
});

describe('Site Studio / uploaded static sites', () => {
  it.each([
    { static: true, staticSource: 'upload' },
    { static: true, siteStudioStack: 'static' },
    { siteStudioStack: 'static' },
  ])('never get PR previews — their publish path would overwrite production (%o)', async (settings) => {
    setProject({ gitRepoUrl: null, settings: { ...settings, previewDeploymentsEnabled: true } });
    expect(isPublishedStaticSite(h.project!.settings as Record<string, unknown>)).toBe(true);
    expect(await previewService.isPreviewEnabled(PROJECT_ID)).toBe(false);
  });

  it('a git-built static framework is not treated as a published static site', () => {
    expect(isPublishedStaticSite({ previewDeploymentsEnabled: true })).toBe(false);
    expect(isPublishedStaticSite(null)).toBe(false);
  });
});
