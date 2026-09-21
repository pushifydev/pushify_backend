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
  repoAccess: vi.fn(),
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
  githubService: { getIntegration: mocks.githubIntegration, repoAccess: mocks.repoAccess },
}));

vi.mock('./gitlab.service', () => ({
  gitlabService: { getIntegration: mocks.gitlabIntegration },
}));

vi.mock('../lib/encryption', () => ({
  decrypt: (value: string) => `decrypted:${value}`,
  encrypt: (value: string) => value,
}));

import {
  getProjectGitAccessToken,
  resolveProjectGitAccess,
  detectGitProviderFromUrl,
  noRepoAccessMessage,
} from './git-provider-access.service';
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
  mocks.repoAccess.mockResolvedValue('yes');
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
    mocks.findInstallationForRepo.mockResolvedValue({ installationId: 42, accountLogin: 'acme' });

    const result = await getProjectGitAccessToken('project-1');

    expect(result).toEqual({ provider: 'github', token: 'ghs_installation', source: 'app', account: 'acme' });
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
    mocks.githubIntegration.mockResolvedValue({ accessToken: 'oauth-token', providerUsername: 'acme-owner' });

    const result = await getProjectGitAccessToken('project-1');

    expect(result).toEqual({
      provider: 'github',
      token: 'decrypted:oauth-token',
      source: 'oauth',
      account: 'acme-owner',
    });
    expect(mocks.repoAccess).toHaveBeenCalledWith('acme', 'site', 'decrypted:oauth-token');
  });

  it('falls back to the owner OAuth token when the installation lookup fails', async () => {
    // Returning null here sent private repos to `git clone` with no credentials at all
    // ("could not read Username for 'https://github.com'") even though the owner token worked.
    mocks.findInstallationForRepo.mockRejectedValue(new Error('github is down'));

    const result = await getProjectGitAccessToken('project-1');
    expect(result?.token).toBe('decrypted:oauth-token');
    expect(result?.source).toBe('oauth');
  });

  it('falls back to the owner OAuth token when minting the installation token fails', async () => {
    mocks.findInstallationForRepo.mockResolvedValue({ installationId: 42 });
    mocks.tokenFor.mockRejectedValue(new Error('Could not mint a GitHub installation token (HTTP 401)'));

    const result = await getProjectGitAccessToken('project-1');
    expect(result?.token).toBe('decrypted:oauth-token');
    expect(result?.source).toBe('oauth');
  });

  it("tries the acting member's own connection before the owner's", async () => {
    mocks.githubIntegration.mockImplementation(async (userId: string) =>
      userId === 'member-1' ? { accessToken: 'member-token' } : { accessToken: 'oauth-token' }
    );

    const result = await getProjectGitAccessToken('project-1', { preferUserId: 'member-1' });
    expect(result?.token).toBe('decrypted:member-token');
  });

  it('skips a connection that cannot see the repository and uses the next one', async () => {
    // The member switched their GitHub account: their token is valid but not for this repo.
    mocks.githubIntegration.mockImplementation(async (userId: string) =>
      userId === 'member-1' ? { accessToken: 'other-account' } : { accessToken: 'oauth-token' }
    );
    mocks.repoAccess.mockImplementation(async (_o: string, _r: string, token?: string) =>
      token === 'decrypted:other-account' ? 'no' : 'yes'
    );

    const result = await getProjectGitAccessToken('project-1', { preferUserId: 'member-1' });
    expect(result?.token).toBe('decrypted:oauth-token');
  });

  it('uses a connection GitHub could not confirm when nothing better exists', async () => {
    mocks.repoAccess.mockResolvedValue('unknown');
    const result = await getProjectGitAccessToken('project-1');
    expect(result?.token).toBe('decrypted:oauth-token');
  });

  it('returns nothing when every connection is refused', async () => {
    mocks.repoAccess.mockResolvedValue('no');
    expect(await getProjectGitAccessToken('project-1')).toBeNull();
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

    expect(result).toMatchObject({
      provider: 'gitlab',
      token: 'decrypted:gitlab-token',
      source: 'oauth',
    });
    expect(mocks.findInstallationForRepo).not.toHaveBeenCalled();
    expect(mocks.repoAccess).not.toHaveBeenCalled();
  });

  it('returns nothing for a project with no repository', async () => {
    mocks.findProject.mockResolvedValue(project({ gitRepoUrl: null }));
    expect(await getProjectGitAccessToken('project-1')).toBeNull();
  });

  it('never throws outwards when every lookup fails', async () => {
    mocks.findInstallationForRepo.mockRejectedValue(new Error('github is down'));
    mocks.findOwner.mockRejectedValue(new Error('db is down'));
    expect(await getProjectGitAccessToken('project-1')).toBeNull();
  });
});

describe('resolveProjectGitAccess', () => {
  it('reports a private repo nobody connected can read', async () => {
    mocks.repoAccess.mockResolvedValue('no');

    const result = await resolveProjectGitAccess('project-1', { checkPublic: true });

    expect(result).toMatchObject({ provider: 'github', repoFullName: 'acme/site', credential: null, isPublic: false });
    // the last call is the anonymous one
    expect(mocks.repoAccess).toHaveBeenLastCalledWith('acme', 'site');
  });

  it('reports a public repo, which clones without credentials', async () => {
    mocks.githubIntegration.mockResolvedValue(null);
    mocks.repoAccess.mockResolvedValue('yes');

    const result = await resolveProjectGitAccess('project-1', { checkPublic: true });
    expect(result).toMatchObject({ credential: null, isPublic: true });
  });

  it('does not look the repo up anonymously unless asked', async () => {
    mocks.githubIntegration.mockResolvedValue(null);
    const result = await resolveProjectGitAccess('project-1');
    expect(result.isPublic).toBeNull();
    expect(mocks.repoAccess).not.toHaveBeenCalled();
  });

  it('treats a non-git project as having no provider', async () => {
    mocks.findProject.mockResolvedValue(project({ gitProvider: null, gitRepoUrl: 'https://wordpress.org' }));
    const result = await resolveProjectGitAccess('project-1', { checkPublic: true });
    expect(result).toEqual({ provider: null, repoFullName: null, credential: null, isPublic: null });
  });
});

describe('noRepoAccessMessage', () => {
  it('names the repository and the account the App has to be installed on', () => {
    const message = noRepoAccessMessage('acme/site');
    expect(message).toContain('github.com/acme/site');
    expect(message).toContain('@acme');
  });
});
