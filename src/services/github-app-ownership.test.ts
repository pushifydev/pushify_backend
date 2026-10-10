import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The two GitHub calls the setup callback relies on before it claims an installation: does the
 * installation exist (asked as the App), and can this user reach it (asked with their token).
 */
vi.mock('../config/env', () => ({
  env: { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'key' },
}));
vi.mock('../db', () => ({ db: {} }));
vi.mock('../lib/github-app-auth', () => ({
  createAppJwt: vi.fn(async () => 'app-jwt'),
  forgetInstallationToken: vi.fn(),
  getInstallationToken: vi.fn(),
  verifyAppCredentials: vi.fn(),
}));

const { githubAppService } = await import('./github-app.service');

const fetchMock = vi.fn();

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchInstallation', () => {
  it('returns the account GitHub reports, asked with the App JWT', async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        account: { login: 'acme', id: 7, type: 'Organization' },
        repository_selection: 'selected',
        suspended_at: null,
      })
    );

    const result = await githubAppService.fetchInstallation(42);

    expect(result).toEqual({
      accountLogin: 'acme',
      accountId: 7,
      accountType: 'Organization',
      repositorySelection: 'selected',
      suspended: false,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/app/installations/42');
    expect(init.headers.Authorization).toBe('Bearer app-jwt');
  });

  it('returns null for an id GitHub does not know', async () => {
    fetchMock.mockResolvedValue(json(404, { message: 'Not Found' }));
    expect(await githubAppService.fetchInstallation(999999)).toBeNull();
  });

  it('throws on any other failure rather than pretending the installation exists', async () => {
    fetchMock.mockResolvedValue(json(500, {}));
    await expect(githubAppService.fetchInstallation(42)).rejects.toThrow(/500/);
  });
});

describe('userCanAccessInstallation', () => {
  it('is true when the installation is in the user\'s list', async () => {
    fetchMock.mockResolvedValue(json(200, { installations: [{ id: 1 }, { id: 42 }] }));

    expect(await githubAppService.userCanAccessInstallation('user-token', 42)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/user/installations');
    expect(init.headers.Authorization).toBe('Bearer user-token');
  });

  it('is false when the installation is not in the user\'s list', async () => {
    fetchMock.mockResolvedValue(json(200, { installations: [{ id: 1 }] }));
    expect(await githubAppService.userCanAccessInstallation('user-token', 42)).toBe(false);
  });

  it('follows pagination', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i }));
    fetchMock
      .mockResolvedValueOnce(json(200, { installations: fullPage }))
      .mockResolvedValueOnce(json(200, { installations: [{ id: 42 }] }));

    expect(await githubAppService.userCanAccessInstallation('user-token', 42)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('is false when GitHub refuses the token', async () => {
    fetchMock.mockResolvedValue(json(403, { message: 'Forbidden' }));
    expect(await githubAppService.userCanAccessInstallation('user-token', 42)).toBe(false);
  });
});
