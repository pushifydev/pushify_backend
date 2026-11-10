import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  cancelSuperseded: vi.fn(),
  publish: vi.fn(),
  setCommitStatus: vi.fn(),
  credential: null as { provider: string; token: string } | null,
}));

vi.mock('../repositories/project.repository', () => ({ projectRepository: { findById: async () => h.project } }));
vi.mock('../repositories/deployment.repository', () => ({
  deploymentRepository: { cancelSuperseded: h.cancelSuperseded },
}));
vi.mock('../config/env', () => ({ env: { FRONTEND_URL: 'https://app.test' } }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./ws', () => ({ wsManager: { publish: h.publish } }));
vi.mock('../services/github.service', () => ({
  githubService: {
    parseRepoFromUrl: () => ({ owner: 'acme', repo: 'shop' }),
    setCommitStatus: h.setCommitStatus,
  },
}));
vi.mock('../services/git-provider-access.service', () => ({ getProjectGitAccessToken: async () => h.credential }));

const { cancelSupersededDeployments, supersedeStatuses, supersededMessage } = await import('./deploy-supersede');

const push = {
  id: 'dep-new',
  projectId: 'proj-1',
  trigger: 'git_push',
  createdAt: new Date('2026-11-10T10:00:00Z'),
  environment: 'production',
  branch: 'main',
  commitHash: 'bbbbbbbbbbbbbbbbbbbb',
  isPreview: false,
  previewPrNumber: null,
};

/** Let the fire-and-forget GitHub report finish */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  h.project = { id: 'proj-1', settings: {}, gitRepoUrl: 'https://github.com/acme/shop' };
  h.cancelSuperseded.mockReset().mockResolvedValue([{ id: 'dep-old', commitHash: 'aaaaaaaaaaaaaaaa' }]);
  h.publish.mockReset().mockResolvedValue(undefined);
  h.setCommitStatus.mockReset().mockResolvedValue(undefined);
  h.credential = { provider: 'github', token: 'ghs_token' };
});

describe('supersedeStatuses (project settings)', () => {
  it('cancels queued deploys by default, building ones only when opted in, nothing when turned off', () => {
    expect(supersedeStatuses({})).toEqual(['pending']);
    expect(supersedeStatuses(null)).toEqual(['pending']);
    expect(supersedeStatuses({ cancelSupersededBuilds: true })).toEqual(['pending', 'building']);
    expect(supersedeStatuses({ cancelSupersededDeploys: false })).toEqual([]);
    expect(supersedeStatuses({ cancelSupersededDeploys: false, cancelSupersededBuilds: true })).toEqual([]);
  });
});

describe('supersededMessage', () => {
  it('names the branch or PR and the commit that replaced the deploy', () => {
    expect(supersededMessage(push)).toBe('[Superseded] Cancelled automatically: a newer push to main (bbbbbbb) replaced it');
    expect(supersededMessage({ ...push, isPreview: true, previewPrNumber: 7 })).toContain('a newer push to PR #7 (bbbbbbb)');
  });
});

describe('cancelSupersededDeployments', () => {
  it('cancels the older queued deploys of the same branch, with the reason, and tells the dashboard', async () => {
    const ids = await cancelSupersededDeployments(push);

    expect(ids).toEqual(['dep-old']);
    expect(h.cancelSuperseded).toHaveBeenCalledWith(push, ['pending'], expect.stringMatching(/^\[Superseded\] /));
    expect(h.publish).toHaveBeenCalledWith('project:proj-1', {
      type: 'deployment:status',
      data: expect.objectContaining({ deploymentId: 'dep-old', status: 'cancelled' }),
    });
  });

  it('also cancels deploys still building when the project opted in', async () => {
    h.project!.settings = { cancelSupersededBuilds: true };
    await cancelSupersededDeployments(push);
    expect(h.cancelSuperseded).toHaveBeenCalledWith(push, ['pending', 'building'], expect.any(String));
  });

  it('does nothing when the project turned it off', async () => {
    h.project!.settings = { cancelSupersededDeploys: false };
    expect(await cancelSupersededDeployments(push)).toEqual([]);
    expect(h.cancelSuperseded).not.toHaveBeenCalled();
  });

  it.each(['manual', 'redeploy', 'rollback'])('a %s deploy never cancels anything', async (trigger) => {
    expect(await cancelSupersededDeployments({ ...push, trigger })).toEqual([]);
    expect(h.cancelSuperseded).not.toHaveBeenCalled();
  });

  it('never fails the new deploy when cancelling the old ones fails', async () => {
    h.cancelSuperseded.mockRejectedValue(new Error('connection lost'));
    await expect(cancelSupersededDeployments(push)).resolves.toEqual([]);
  });

  it('marks the cancelled commit `error` with the reason on GitHub when status checks are on', async () => {
    h.project!.settings = { prStatusChecksEnabled: true };
    await cancelSupersededDeployments(push);
    await settle();

    expect(h.setCommitStatus).toHaveBeenCalledOnce();
    expect(h.setCommitStatus).toHaveBeenCalledWith(
      'ghs_token',
      'acme',
      'shop',
      'aaaaaaaaaaaaaaaa',
      'error',
      expect.stringContaining('a newer push to main (bbbbbbb)'),
      'https://app.test/dashboard/projects/proj-1?tab=deployments&deployment=dep-old'
    );
  });

  it('leaves the commit statuses alone without status checks, without a GitHub token, or for the same commit', async () => {
    await cancelSupersededDeployments(push);
    await settle();

    h.project!.settings = { prStatusChecksEnabled: true };
    h.credential = { provider: 'gitlab', token: 't' };
    await cancelSupersededDeployments(push);
    await settle();

    h.credential = { provider: 'github', token: 't' };
    h.cancelSuperseded.mockResolvedValue([{ id: 'dep-old', commitHash: push.commitHash }]);
    await cancelSupersededDeployments(push);
    await settle();

    expect(h.setCommitStatus).not.toHaveBeenCalled();
  });
});
