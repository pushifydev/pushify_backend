import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The App-aware pieces that decide *which credential* a deploy uses. The failure this replaces
 * is concrete: every deploy used to borrow the organisation owner's personal OAuth token, so the
 * owner leaving, revoking the grant or rotating the token stopped every project in the org.
 */
const mocks = vi.hoisted(() => ({
  findInstallationForRepo: vi.fn(),
  tokenFor: vi.fn(),
  findProject: vi.fn(),
  findOwner: vi.fn(),
  githubIntegration: vi.fn(),
  gitlabIntegration: vi.fn(),
}));

vi.mock('./github-app.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github-app.service')>();
  return {
    ...actual,
    githubAppService: {
      ...actual.githubAppService,
      findInstallationForRepo: mocks.findInstallationForRepo,
      tokenFor: mocks.tokenFor,
    },
  };
});

vi.mock('../repositories/project.repository', () => ({
  projectRepository: { findById: mocks.findProject },
}));

vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: { findOwner: mocks.findOwner },
}));

vi.mock('./github.service', () => ({
  githubService: { getIntegration: mocks.githubIntegration },
}));

vi.mock('./gitlab.service', () => ({
  gitlabService: { getIntegration: mocks.gitlabIntegration },
}));

vi.mock('../lib/encryption', () => ({
  decrypt: (value: string) => `decrypted:${value}`,
  encrypt: (value: string) => value,
}));

import { getProjectGitAccessToken, detectGitProviderFromUrl } from './git-provider-access.service';
import { repoFullNameFromUrl } from './github-app.service';

const project = (overrides: Record<string, unknown> = {}) => ({
  id: 'project-1',
  organizationId: 'org-1',
  gitRepoUrl: 'https://github.com/acme/site',
  gitProvider: 'github',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findProject.mockResolvedValue(project());
  mocks.findOwner.mockResolvedValue({ userId: 'owner-1' });
  mocks.githubIntegration.mockResolvedValue({ accessToken: 'oauth-token' });
  mocks.gitlabIntegration.mockResolvedValue({ accessToken: 'gitlab-token' });
  mocks.findInstallationForRepo.mockResolvedValue(null);
  mocks.tokenFor.mockResolvedValue('ghs_installation');
});

describe('repoFullNameFromUrl', () => {
  it('reads owner/repo out of every URL shape we store', () => {
    for (const url of [
      'https://github.com/acme/site',
      'https://github.com/acme/site.git',
      'git@github.com:acme/site.git',
      'https://github.com/acme/site/',
    ]) {
      expect(repoFullNameFromUrl(url)).toBe('acme/site');
    }
  });

  it('returns null for anything that is not a GitHub URL', () => {
    expect(repoFullNameFromUrl('https://gitlab.com/acme/site')).toBeNull();
    expect(repoFullNameFromUrl(null)).toBeNull();
    expect(repoFullNameFromUrl('')).toBeNull();
  });
});

describe('detectGitProviderFromUrl', () => {
  it('tells the two providers apart', () => {
    expect(detectGitProviderFromUrl('https://github.com/a/b')).toBe('github');
    expect(detectGitProviderFromUrl('https://gitlab.com/a/b')).toBe('gitlab');
    expect(detectGitProviderFromUrl('https://example.com/a/b')).toBeNull();
  });
});

describe('getProjectGitAccessToken', () => {
  it('prefers an App installation over the owner OAuth token', async () => {
    mocks.findInstallationForRepo.mockResolvedValue({ installationId: 42 });

    const result = await getProjectGitAccessToken('project-1');

    expect(result).toEqual({ provider: 'github', token: 'ghs_installation', source: 'app' });
    expect(mocks.githubIntegration).not.toHaveBeenCalled();
  });

  it('keeps deploying through an installation when the organisation has no owner integration', async () => {
    // This is the case the OAuth model fails: the owner is gone, but the installation belongs
    // to the GitHub account, not to them.
    mocks.findInstallationForRepo.mockResolvedValue({ installationId: 42 });
    mocks.findOwner.mockResolvedValue(null);
    mocks.githubIntegration.mockResolvedValue(null);

    const result = await getProjectGitAccessToken('project-1');
    expect(result?.source).toBe('app');
  });

  it('falls back to the owner OAuth token when no installation covers the repository', async () => {
    const result = await getProjectGitAccessToken('project-1');

    expect(result).toEqual({
      provider: 'github',
      token: 'decrypted:oauth-token',
      source: 'oauth',
    });
  });

  it('returns nothing when neither credential exists', async () => {
    mocks.githubIntegration.mockResolvedValue(null);
    expect(await getProjectGitAccessToken('project-1')).toBeNull();
  });

  it('leaves GitLab on its own path', async () => {
    mocks.findProject.mockResolvedValue(
      project({ gitProvider: 'gitlab', gitRepoUrl: 'https://gitlab.com/acme/site' })
    );

    const result = await getProjectGitAccessToken('project-1');

    expect(result).toEqual({
      provider: 'gitlab',
      token: 'decrypted:gitlab-token',
      source: 'oauth',
    });
    expect(mocks.findInstallationForRepo).not.toHaveBeenCalled();
  });

  it('returns nothing for a project with no repository', async () => {
    mocks.findProject.mockResolvedValue(project({ gitRepoUrl: null }));
    expect(await getProjectGitAccessToken('project-1')).toBeNull();
  });

  it('never throws outwards when a lookup fails', async () => {
    mocks.findInstallationForRepo.mockRejectedValue(new Error('github is down'));
    expect(await getProjectGitAccessToken('project-1')).toBeNull();
  });
});
