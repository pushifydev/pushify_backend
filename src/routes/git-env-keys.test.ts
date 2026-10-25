import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * GET …/env-keys hands the branch and root directory to the service and refuses a root directory
 * that leaves the repository before any request reaches GitHub / GitLab.
 */
const mocks = vi.hoisted(() => ({
  githubDetectEnvKeys: vi.fn(),
  gitlabDetectEnvKeys: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('organizationId', 'org-1');
    c.set('locale', 'en');
    await next();
  },
}));
vi.mock('../lib/oauth-state-store', () => ({
  createOAuthState: vi.fn(),
  consumeOAuthState: vi.fn(),
  validateOAuthStateRecord: vi.fn(),
}));
vi.mock('../services/github-app.service', () => ({ githubAppService: {} }));
vi.mock('../services/github.service', () => ({
  githubService: { getAccessToken: async () => 'gh-token', detectEnvKeys: mocks.githubDetectEnvKeys },
  hasRepoScope: () => true,
}));
vi.mock('../services/gitlab.service', () => ({
  gitlabService: { getAccessToken: async () => 'gl-token', detectEnvKeys: mocks.gitlabDetectEnvKeys },
}));

const { githubRoutes } = await import('./github');
const { gitlabRoutes } = await import('./gitlab');

const detection = { source: 'apps/web/.env.example', keys: [{ key: 'DATABASE_URL', hasDefault: true }] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.githubDetectEnvKeys.mockResolvedValue(detection);
  mocks.gitlabDetectEnvKeys.mockResolvedValue(detection);
});

describe('GET /integrations/github/repos/:owner/:repo/env-keys', () => {
  it('passes branch and root directory through and returns names only', async () => {
    const res = await githubRoutes.request('/repos/acme/mono/env-keys?branch=dev&rootDirectory=apps/web');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: detection });
    expect(mocks.githubDetectEnvKeys).toHaveBeenCalledWith('gh-token', 'acme', 'mono', 'dev', 'apps/web');
  });

  it('refuses a root directory outside the repository', async () => {
    const res = await githubRoutes.request('/repos/acme/mono/env-keys?rootDirectory=../other');

    expect(res.status).toBe(400);
    expect(mocks.githubDetectEnvKeys).not.toHaveBeenCalled();
  });
});

describe('GET /integrations/gitlab/projects/:projectId/env-keys', () => {
  it('passes branch and root directory through and returns names only', async () => {
    const res = await gitlabRoutes.request('/projects/42/env-keys?branch=dev&rootDirectory=apps/web');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: detection });
    expect(mocks.gitlabDetectEnvKeys).toHaveBeenCalledWith('gl-token', 42, 'dev', 'apps/web');
  });

  it('refuses a root directory outside the repository', async () => {
    const res = await gitlabRoutes.request('/projects/42/env-keys?rootDirectory=apps/../../x');

    expect(res.status).toBe(400);
    expect(mocks.gitlabDetectEnvKeys).not.toHaveBeenCalled();
  });
});
