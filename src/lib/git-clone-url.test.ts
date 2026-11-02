import { afterEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({ GITLAB_BASE_URL: undefined as string | undefined }));
vi.mock('../config/env', () => ({ env: mockEnv }));

const { authenticatedCloneUrl, gitHostOf, parseGitRemote } = await import('./git-clone-url');

/**
 * A member picks the repository URL; the token on it belongs to the organisation owner or the
 * GitHub App. A URL that only *mentions* github.com/gitlab used to get the token, and git sent it
 * as Basic auth to whatever host the URL really named.
 */
describe('authenticatedCloneUrl', () => {
  afterEach(() => {
    mockEnv.GITLAB_BASE_URL = undefined;
  });

  it.each([
    'https://evil.example/github.com/acme/repo',
    'https://gitlab.evil.example/x/y',
    'https://evil.example/https://github.com/a/b',
    'https://github.com.evil.example/acme/repo',
    'https://github.com@evil.example/acme/repo',
    'https://evil.example/?u=https://gitlab.com/x/y',
    'http://gitlab.com/x/y',
    'http://github.com/acme/repo',
    'git@github.com:acme/repo.git',
    'ssh://git@github.com/acme/repo.git',
    'not a url github.com',
  ])('does not put the token on %s', (repoUrl) => {
    const cloneUrl = authenticatedCloneUrl(repoUrl, 'SECRET');
    expect(cloneUrl).toBe(repoUrl);
    expect(cloneUrl).not.toContain('SECRET');
  });

  it('adds an x-access-token login for https github.com', () => {
    expect(authenticatedCloneUrl('https://github.com/acme/repo', 'ghs_abc')).toBe(
      'https://x-access-token:ghs_abc@github.com/acme/repo'
    );
    expect(authenticatedCloneUrl('https://GitHub.com/acme/repo.git', 'ghs_abc')).toBe(
      'https://x-access-token:ghs_abc@github.com/acme/repo.git'
    );
  });

  it('adds an oauth2 login for https gitlab.com', () => {
    expect(authenticatedCloneUrl('https://gitlab.com/group/sub/repo.git', 'glpat-x')).toBe(
      'https://oauth2:glpat-x@gitlab.com/group/sub/repo.git'
    );
  });

  it("adds it for the self-hosted GitLab the OAuth app lives on, and only that host", () => {
    mockEnv.GITLAB_BASE_URL = 'https://git.acme.internal';
    expect(authenticatedCloneUrl('https://git.acme.internal/team/app.git', 'glpat-x')).toBe(
      'https://oauth2:glpat-x@git.acme.internal/team/app.git'
    );
    expect(authenticatedCloneUrl('https://git.acme.internal.evil.example/team/app.git', 'glpat-x')).not.toContain(
      'glpat-x'
    );
  });

  it('replaces credentials already in the URL instead of stacking them', () => {
    expect(authenticatedCloneUrl('https://someone:pw@github.com/acme/repo', 'ghs_abc')).toBe(
      'https://x-access-token:ghs_abc@github.com/acme/repo'
    );
  });

  it('percent-encodes a token with URL-unsafe characters', () => {
    const cloneUrl = authenticatedCloneUrl('https://github.com/acme/repo', 'a b/@c');
    expect(new URL(cloneUrl).host).toBe('github.com');
    expect(cloneUrl).not.toContain('a b/@c');
  });

  it('returns the URL untouched without a token', () => {
    expect(authenticatedCloneUrl('https://github.com/acme/repo', undefined)).toBe('https://github.com/acme/repo');
    expect(authenticatedCloneUrl('https://github.com/acme/repo', '')).toBe('https://github.com/acme/repo');
  });
});

describe('gitHostOf', () => {
  afterEach(() => {
    mockEnv.GITLAB_BASE_URL = undefined;
  });

  it('goes by the exact host', () => {
    expect(gitHostOf('https://github.com/a/b')).toBe('github');
    expect(gitHostOf('git@github.com:a/b.git')).toBe('github');
    expect(gitHostOf('https://gitlab.com/a/b')).toBe('gitlab');
    expect(gitHostOf('https://evil.example/github.com/a/b')).toBeNull();
    expect(gitHostOf('https://gitlab.evil.example/x/y')).toBeNull();
    expect(gitHostOf('https://github.com.evil.example/a/b')).toBeNull();
    expect(gitHostOf(null)).toBeNull();
  });

  it('knows the configured GitLab host', () => {
    mockEnv.GITLAB_BASE_URL = 'https://git.acme.internal:8443/';
    expect(gitHostOf('https://git.acme.internal:8443/a/b')).toBe('gitlab');
    expect(gitHostOf('https://git.acme.internal/a/b')).toBeNull();
  });
});

describe('parseGitRemote', () => {
  it('reads host and path from URLs and the scp-like form', () => {
    expect(parseGitRemote('https://github.com/acme/site.git')).toEqual({ host: 'github.com', path: '/acme/site.git' });
    expect(parseGitRemote('git@github.com:acme/site.git')).toEqual({ host: 'github.com', path: 'acme/site.git' });
    expect(parseGitRemote('file:///tmp/repo')).toBeNull();
    expect(parseGitRemote('')).toBeNull();
  });
});
