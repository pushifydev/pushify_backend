import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /app/setup links a GitHub App installation to the caller's organisation. The id comes from
 * the request body and installation ids are sequential, so the route must prove the installation
 * exists and that the caller's own GitHub account can reach it before claiming it.
 */
const mocks = vi.hoisted(() => ({
  isConfigured: vi.fn(),
  fetchInstallation: vi.fn(),
  userCanAccessInstallation: vi.fn(),
  syncInstallation: vi.fn(),
  claimInstallation: vi.fn(),
  findByInstallationId: vi.fn(),
  getIntegration: vi.fn(),
  consumeOAuthState: vi.fn(),
  requireOrgMember: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>
  ) => {
    c.set('userId', 'user-1');
    c.set('organizationId', 'org-1');
    c.set('locale', 'en');
    await next();
  },
}));
vi.mock('../lib/org-access', () => ({ requireOrgMember: mocks.requireOrgMember }));
vi.mock('../lib/encryption', () => ({ decrypt: (value: string) => `decrypted:${value}` }));
vi.mock('../lib/oauth-state-store', () => ({
  createOAuthState: vi.fn(),
  consumeOAuthState: mocks.consumeOAuthState,
  validateOAuthStateRecord: vi.fn(),
}));
vi.mock('../services/github.service', () => ({
  githubService: { getIntegration: mocks.getIntegration },
  hasRepoScope: () => true,
}));
vi.mock('../services/github-app.service', () => ({
  githubAppService: {
    isConfigured: mocks.isConfigured,
    fetchInstallation: mocks.fetchInstallation,
    userCanAccessInstallation: mocks.userCanAccessInstallation,
    syncInstallation: mocks.syncInstallation,
    claimInstallation: mocks.claimInstallation,
    findByInstallationId: mocks.findByInstallationId,
  },
}));

const { githubRoutes } = await import('./github');

const remote = {
  accountLogin: 'acme',
  accountId: 7,
  accountType: 'Organization',
  repositorySelection: 'all',
  suspended: false,
};

function setup(installationId = 42) {
  return githubRoutes.request('/app/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId, state: 'state-1' }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireOrgMember.mockResolvedValue(undefined);
  mocks.consumeOAuthState.mockResolvedValue({
    kind: 'github_app_install',
    userId: 'user-1',
    organizationId: 'org-1',
  });
  mocks.isConfigured.mockReturnValue(true);
  mocks.fetchInstallation.mockResolvedValue(remote);
  mocks.getIntegration.mockResolvedValue({ accessToken: 'oauth-token' });
  mocks.userCanAccessInstallation.mockResolvedValue(true);
  mocks.syncInstallation.mockResolvedValue({});
  mocks.claimInstallation.mockResolvedValue({
    installationId: 42,
    organizationId: 'org-1',
    accountLogin: 'acme',
  });
  mocks.findByInstallationId.mockResolvedValue(null);
});

describe('POST /app/setup', () => {
  it('links an installation the user can reach on GitHub', async () => {
    const res = await setup();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { installationId: 42, accountLogin: 'acme' } });
    expect(mocks.userCanAccessInstallation).toHaveBeenCalledWith('decrypted:oauth-token', 42);
    expect(mocks.syncInstallation).toHaveBeenCalledWith({ installationId: 42, ...remote });
    expect(mocks.claimInstallation).toHaveBeenCalledWith(42, 'org-1', 'user-1');
  });

  it('answers 404 for an installation GitHub does not know, without recording anything', async () => {
    mocks.fetchInstallation.mockResolvedValue(null);

    const res = await setup(999999);

    expect(res.status).toBe(404);
    expect(mocks.syncInstallation).not.toHaveBeenCalled();
    expect(mocks.claimInstallation).not.toHaveBeenCalled();
  });

  it('answers 403 when the user cannot reach the installation with their own GitHub account', async () => {
    mocks.userCanAccessInstallation.mockResolvedValue(false);

    const res = await setup();

    expect(res.status).toBe(403);
    expect(mocks.syncInstallation).not.toHaveBeenCalled();
    expect(mocks.claimInstallation).not.toHaveBeenCalled();
  });

  it('answers 403 when the user has no GitHub account connected', async () => {
    mocks.getIntegration.mockResolvedValue(null);

    const res = await setup();

    expect(res.status).toBe(403);
    expect(mocks.userCanAccessInstallation).not.toHaveBeenCalled();
    expect(mocks.claimInstallation).not.toHaveBeenCalled();
  });

  it('answers 409 for an installation already linked to another organisation', async () => {
    mocks.claimInstallation.mockResolvedValue(null);
    mocks.findByInstallationId.mockResolvedValue({
      installationId: 42,
      organizationId: 'org-other',
      accountLogin: 'acme',
    });

    const res = await setup();

    expect(res.status).toBe(409);
  });

  it('answers 502 when GitHub cannot be asked, instead of trusting the id', async () => {
    mocks.fetchInstallation.mockRejectedValue(new Error('GitHub is down'));

    const res = await setup();

    expect(res.status).toBe(502);
    expect(mocks.claimInstallation).not.toHaveBeenCalled();
  });

  it('rejects a state that was not issued to this user and organisation', async () => {
    mocks.consumeOAuthState.mockResolvedValue(null);

    const res = await setup();

    expect(res.status).toBe(400);
    expect(mocks.fetchInstallation).not.toHaveBeenCalled();
  });
});
