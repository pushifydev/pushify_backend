import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Settings → GitHub access reads this. The status has to match what a *push* deploy would do
 * (App or org owner only), while still telling a member when only their own account works.
 */
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  getIntegration: vi.fn(),
  appConfigured: vi.fn(),
}));

vi.mock('./git-provider-access.service', () => ({ resolveProjectGitAccess: mocks.resolve }));
vi.mock('./github.service', () => ({
  githubService: { getIntegration: mocks.getIntegration },
  hasRepoScope: (scopes: string | null) => String(scopes ?? '').split(/[\s,]+/).includes('repo'),
}));
vi.mock('./github-app.service', () => ({ githubAppService: { isConfigured: mocks.appConfigured } }));

import { projectService } from './project.service';

const base = { provider: 'github', repoFullName: 'acme/site', credential: null, isPublic: null };
const oauth = (account: string) => ({ provider: 'github', token: 't', source: 'oauth', account });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(projectService, 'getById').mockResolvedValue({ id: 'project-1' } as never);
  mocks.getIntegration.mockResolvedValue({ providerUsername: 'me', scopes: 'repo,read:user' });
  mocks.appConfigured.mockReturnValue(true);
});

const access = () => projectService.getGitAccess('project-1', 'org-1', 'user-1', 'en');

describe('projectService.getGitAccess', () => {
  it('is ok when the App or the owner can read the repo, and never returns the token', async () => {
    mocks.resolve.mockResolvedValueOnce({ ...base, credential: { ...oauth('owner'), source: 'app', account: 'acme' } });

    const result = await access();

    expect(result).toMatchObject({ status: 'ok', repoOwner: 'acme', via: { source: 'app', account: 'acme' } });
    expect(JSON.stringify(result)).not.toContain('"token"');
    // the shared (push) check runs without the viewer
    expect(mocks.resolve).toHaveBeenCalledWith('project-1', { checkPublic: true });
  });

  it('is viewer_only when just the caller’s own account can read it', async () => {
    mocks.resolve
      .mockResolvedValueOnce({ ...base, isPublic: false })
      .mockResolvedValueOnce({ ...base, credential: oauth('me') });

    const result = await access();

    expect(result).toMatchObject({ status: 'viewer_only', via: { source: 'oauth', account: 'me' } });
    expect(mocks.resolve).toHaveBeenLastCalledWith('project-1', { preferUserId: 'user-1' });
  });

  it('is public for a public repo even if the viewer could read it too', async () => {
    mocks.resolve.mockResolvedValueOnce({ ...base, isPublic: true });

    const result = await access();

    expect(result.status).toBe('public');
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });

  it('is no_access for a private repo nobody connected can see', async () => {
    mocks.resolve.mockResolvedValueOnce({ ...base, isPublic: false }).mockResolvedValueOnce({ ...base });
    expect((await access()).status).toBe('no_access');
  });

  it('is unknown when GitHub could not be asked', async () => {
    mocks.resolve.mockResolvedValueOnce({ ...base }).mockResolvedValueOnce({ ...base });
    expect((await access()).status).toBe('unknown');
  });

  it('is not_git for a project without a git provider', async () => {
    mocks.resolve.mockResolvedValueOnce({ provider: null, repoFullName: null, credential: null, isPublic: null });
    expect((await access()).status).toBe('not_git');
  });

  it('reports the viewer’s own connection and whether it can see private repos', async () => {
    mocks.resolve.mockResolvedValueOnce({ ...base, isPublic: true });
    mocks.getIntegration.mockResolvedValue({ providerUsername: 'me', scopes: 'read:user,user:email' });

    const result = await access();
    expect(result.viewer).toEqual({ connected: true, username: 'me', hasRepoScope: false });
  });
});
